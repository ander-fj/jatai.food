require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

// Inicializar Express
const app = express();

// Habilita o CORS para todas as origens.
app.use(cors());
app.use(express.json());

// Armazenar clientes WhatsApp por usuário
const whatsappClients = new Map();
const qrCodes = new Map();
const connectionStatus = new Map();
const notifiedOfUnavailableAI = new Set(); // Rastreia usuários já notificados sobre a IA indisponível
const conversationState = new Map(); // Armazena o estado da conversa para cada usuário

let db = null; // Inicia o db como nulo. Será preenchido se a conexão for bem-sucedida.

// Inicializar Firebase Admin
if (!admin.apps.length) {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_DATABASE_URL } = process.env;

  console.log('🔍 Tentando inicializar o Firebase Admin SDK...');
  console.log(`- FIREBASE_PROJECT_ID: ${FIREBASE_PROJECT_ID ? 'Definido' : 'NÃO DEFINIDO'}`);
  console.log(`- FIREBASE_CLIENT_EMAIL: ${FIREBASE_CLIENT_EMAIL ? 'Definido' : 'NÃO DEFINIDO'}`);
  console.log(`- FIREBASE_PRIVATE_KEY: ${FIREBASE_PRIVATE_KEY ? 'Definido' : 'NÃO DEFINIDO'}`);
  console.log(`- FIREBASE_DATABASE_URL: ${FIREBASE_DATABASE_URL || '(Usando fallback: https://dhl-teste-327e8-default-rtdb.firebaseio.com)'}`);

  if (FIREBASE_PROJECT_ID && FIREBASE_CLIENT_EMAIL && FIREBASE_PRIVATE_KEY) {
    try {
      const databaseURL = FIREBASE_DATABASE_URL || 'https://dhl-teste-327e8-default-rtdb.firebaseio.com';
      const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
      const firebaseApp = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: FIREBASE_PROJECT_ID,
          clientEmail: FIREBASE_CLIENT_EMAIL,
          privateKey: privateKey,
        }),
        databaseURL: databaseURL
      });
      db = firebaseApp.database(); // Atribui a conexão à variável db
      console.log(`✅ Firebase Admin SDK inicializado com sucesso para o projeto: ${FIREBASE_PROJECT_ID} e database: ${databaseURL}`);
    } catch (error) {
      console.error('❌ ERRO CRÍTICO: Falha ao inicializar o Firebase Admin SDK. Verifique as variáveis de ambiente.');
      console.error('- Detalhes do Erro:', error.message);
      db = null; // Garante que o db seja nulo em caso de falha
      console.warn('⚠️ O servidor continuará rodando em modo offline, usando dados de exemplo.');
    } 
  } else {
    console.warn('⚠️ Variáveis de ambiente do Firebase não encontradas no arquivo .env.');
    console.warn('O servidor rodará em modo offline, usando dados de exemplo.');
    db = null;
  }
}

// Função para gerar código de rastreamento
function generateTrackingCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Função para buscar o cardápio do Firebase
async function getMenuFromFirebase(username) {
  if (!db) {
    console.warn('⚠️ Firebase não inicializado. Usando cardápio de exemplo.');
    return 'Pizza de Calabresa, Pizza de Mussarela, Coca-Cola 2L';
  }

  try {
    const menuRef = db.ref('tenants/' + username + '/products');
    const snapshot = await menuRef.once('value');
    if (snapshot.exists()) {
      const products = snapshot.val();
      // Formata o cardápio como uma lista de nomes de produtos (usando function)
      return Object.values(products).map(function(p) {
        return p.name;
      }).join(', ');
    }
    return null;
  } catch (error) {
    console.error('❌ Erro ao buscar cardápio do Firebase:', error);
    return null;
  }
}

// Função para buscar informações da loja
async function getBusinessInfoFromFirebase(username) {
  if (!db) {
    console.warn('⚠️ Firebase não inicializado. Usando informações de loja de exemplo.');
    return {
      restaurantName: 'Restaurante Exemplo',
      welcomeMessage: 'Olá! Bem-vindo ao nosso restaurante.',
      openingHours: '18h às 23h',
      address: 'Rua Exemplo, 123',
      contactPhone: '(00) 12345-6789',
    };
  }

  try {
    const infoRef = db.ref('tenants/' + username + '/whatsappConfig');
    const snapshot = await infoRef.once('value');
    if (snapshot.exists()) {
      return snapshot.val();
    }
    return null;
  } catch (error) {
    console.error('❌ Erro ao buscar informações da loja:', error);
    return null;
  }
}

// Função para buscar o cardápio com preços do Firebase
async function getMenuWithPrices(username) {
  if (!db) {
    console.warn('⚠️ Firebase não inicializado. Usando preços de exemplo.');
    const menuMap = new Map();
    menuMap.set("pizza de calabresa", 30.50);
    menuMap.set("pizza de mussarela", 28.00);
    menuMap.set("coca-cola 2l", 10.00);
    return menuMap;
  }

  try {
    const menuRef = db.ref('tenants/' + username + '/products');
    const snapshot = await menuRef.once('value');
    if (snapshot.exists()) {
      const products = snapshot.val();
      // Cria um mapa para busca rápida de preços por nome de produto (em minúsculas)
      const menuMap = new Map();
      Object.values(products).forEach(function(product) {
        if (product.name && typeof product.price === 'number') {
          menuMap.set(product.name.toLowerCase(), product.price);
        }
      });
      return menuMap;
    }
    return null;
  } catch (error) {
    console.error('❌ Erro ao buscar mapa do cardápio:', error);
    return null;
  }
}

// Função para processar mensagem com Gemini AI
async function processMessageWithGemini(message, menu, menuUrl, lastOrder, conversationContext = null, businessInfo = null) {
  try {
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const genAI = new GoogleGenerativeAI(geminiApiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

    const prompt = [
      "Você é um assistente de IA para o restaurante JataíFood.",
      "",
      "**Sua Personalidade:** Sua personalidade é extremamente amigável, prestativa e um pouco divertida. Use emojis para tornar a conversa mais agradável e próxima do cliente. 🥳🍕 O seu objetivo é ajudar o cliente a fazer o pedido da forma mais fácil e rápida possível, ou responder às suas dúvidas com clareza e bom humor.",
      "",
      "**Contexto da Conversa:**",
      "- **Informações da Loja:**",
      "  - Nome do Restaurante: " + (businessInfo?.restaurantName || 'Não informado'),
      "  - Mensagem de Boas Vindas: " + (businessInfo?.welcomeMessage || 'Olá! Bem-vindo ao nosso restaurante.'),
      "  - Horário: " + (businessInfo?.openingHours || 'Não informado'),
      "  - Endereço: " + (businessInfo?.address || 'Não informado'),
      "  - Telefone de Contato: " + (businessInfo?.contactPhone || 'Não informado'),
      (conversationContext ? '- **Sua Pergunta Anterior Para o Cliente:** "' + conversationContext + '"\n' : ''),
      "- **Cardápio:** [" + (menu || 'Pizzas, Lanches, Refrigerantes') + "]",
      "- **Último Pedido do Cliente:** " + (lastOrder && lastOrder.items && lastOrder.items.length > 0 ? "O cliente pediu " + lastOrder.items.map(function(i) { return i.name; }).join(', ') + " em " + new Date(lastOrder.createdAt).toLocaleDateString('pt-BR') + "." : 'Este é um novo cliente.'),
      "",
      "**Sua Tarefa:**",
      "Analise a mensagem do cliente abaixo e determine a intenção. Sua resposta deve ser **APENAS um objeto JSON**, sem markdown ou qualquer outro texto.",
      "",
      "**REGRA DE OURO:** NUNCA repita a mensagem do cliente na sua resposta. Por exemplo, se o cliente disser \"Oi\", não responda \"Oi, tudo bem?\". Responda diretamente \"Olá! Como posso te ajudar hoje? 😊\".",
      "",
      (conversationContext ? '**Contexto Adicional:** Você fez uma pergunta ao cliente: "' + conversationContext + '". A mensagem a seguir é a resposta dele.\n' : ''),
      "MENSAGEM DO CLIENTE:",
      '"' + message + '"',
      "",
      "**Estrutura da Resposta JSON:**",
      '{ "type": "TIPO", "data": "DADOS" }',
      "",
      "**Regras de Decisão:**",
      "",
      "1.  **Se for a PRIMEIRA MENSAGEM de um cliente antigo (que tem um \"Último Pedido\"):**",
      "    -   Comece a conversa de forma amigável, perguntando sobre o último pedido.",
      "    -   **Exemplo:** { \"type\": \"reply\", \"data\": \"Olá! Que bom te ver de novo! 😊 Na última vez você pediu " + (lastOrder && lastOrder.items && lastOrder.items.length > 0 ? lastOrder.items[0].name : 'seu último pedido') + ", estava gostoso? O que vamos pedir hoje?\" }",
      "",
      "2.  **Se o cliente disser que quer fazer um pedido (ex: \"quero pedir\", \"fazer um pedido\", \"sim\") ou pedir o cardápio:**",
      "    -   Sua resposta **DEVE** ser do \"type\" **\"reply\"**.",
      "    -   O \"data\" **DEVE** ser a seguinte mensagem, direcionando para o site: \n\nClaro! Você pode ver nosso cardápio completo e fazer seu pedido diretamente pelo nosso site: " + menuUrl,
      "",
      "3.  **Se o cliente já listar os itens diretamente (ex: \"quero uma pizza de calabresa\"):**",
      "    -   O \"type\" deve ser **\"order\"**.",
      "    -   O \"data\" deve ser um objeto JSON com os detalhes do pedido (customerName, address, items, etc.).",
      "    -   Baseie-se estritamente nos itens do cardápio.",
      "    -   **REGRA CRÍTICA**: Se for um pedido de entrega, mas o endereço (address) ou a forma de pagamento (paymentMethod) estiverem faltando, **NÃO** gere um pedido. Em vez disso, use o \"type\" **\"clarification\"** para pedir a informação que falta.",
      "        - **Exemplo (falta endereço):** { \"type\": \"clarification\", \"data\": \"Entendi o seu pedido! Para qual endereço será a entrega?\" }",
      "        - **Exemplo (falta pagamento):** { \"type\": \"clarification\", \"data\": \"Pedido quase pronto! Qual será a forma de pagamento (Dinheiro, Cartão, Pix)?\" }",
      "    -   **REGRA DE QUANTIDADE**: Se a quantidade não for explícita (ex: \"uma pizza\"), assuma 1. Extraia apenas o número.",
      "",
      "4.  **Se for uma PERGUNTA GERAL (ex: horário, endereço, telefone):**",
      "    -   O \"type\" deve ser **\"reply\"**.",
      "    -   O \"data\" deve ser uma resposta amigável, usando as \"Informações da Loja\" fornecidas no contexto.",
      "    -   **REGRA IMPORTANTE:** Para responder, use os dados de 'Horário', 'Endereço' e 'Telefone' que estão no início deste prompt, na seção 'Informações da Loja'.",
      "",
      "5.  **Se for uma SAUDAÇÃO (para um cliente novo):**",
      "    -   O \"type\" deve ser **\"reply\"**.",
      "    -   O \"data\" deve ser o valor exato da \"Mensagem de Boas Vindas\" que está nas \"Informações da Loja\".",
      "    -   **Exemplo de JSON resultante:** { \"type\": \"reply\", \"data\": \"Olá! Seja bem-vindo à Pizzaria do Zé. Como posso ajudar?\" }",
      "",
      "6.  **Se for uma CONVERSA CURTA e social (ex: \"obrigado\", \"ok\", \"de nada\", \"blz\"):**",
      "    -   O \"type\" deve ser **\"reply\"**.",
      "    -   O \"data\" deve ser uma resposta curta, natural e apropriada ao contexto. Não inicie um novo fluxo de pedido nem envie a saudação padrão.",
      "    -   **Exemplo (cliente diz \"obrigado\"):** { \"type\": \"reply\", \"data\": \"De nada! 😊 Se precisar de mais alguma coisa, é só chamar.\" }",
      "    -   **Exemplo (cliente diz \"ok\" ou \"blz\"):** { \"type\": \"reply\", \"data\": \"Combinado! 👍\" }",
      "",
      "AGORA, ANALISE A MENSAGEM E RETORNE APENAS O JSON:"
    ].join('\n');

    console.log('🤖 Enviando para Gemini...');
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    console.log('📝 Resposta bruta do Gemini:', text);

    // Tenta extrair um bloco JSON do texto, mesmo que haja texto antes ou depois.
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('❌ Nenhuma string JSON válida encontrada na resposta da IA.');
      return null;
    }

    const jsonText = jsonMatch[0];
    
    console.log('🧹 JSON limpo:', jsonText);
    
    const aiResponse = JSON.parse(jsonText);
    console.log('✅ Resposta da IA processada:', JSON.stringify(aiResponse, null, 2));
    
    return aiResponse;
  } catch (error) {
    console.error('❌ Erro ao processar mensagem com Gemini:', error);
    console.error('❌ Stack:', error.stack);
    return null;
  }
}

// Função para criar pedido no Firebase
async function createOrderInFirebase(username, order, trackingCode, senderId) {
  if (!db) {
    console.warn('⚠️ Firebase não inicializado. Pedido não será salvo.');
    console.log('Dados do pedido (não salvo):', { username, order, trackingCode, senderId });
    return true; // Simula sucesso para que o bot responda ao cliente
  }

  try {
    const orderData = {
      trackingCode,
      customerName: order.customerName || 'Cliente WhatsApp',
      phone: order.phone || '',
      address: order.address || 'Não informado',
      items: order.items.map(function(item) { return {
        name: item.name,
        quantity: item.quantity,
        size: item.size || 'Média',
        price: item.price || 0
      }; }),
      total: order.items.reduce((sum, item) => {
        const price = typeof item.price === 'number' ? item.price : 0;
        const quantity = typeof item.quantity === 'number' ? item.quantity : 0;
        return sum + (price * quantity);
      }, 0),
      status: 'new',
      paymentMethod: order.paymentMethod || 'Não especificado',
      observations: order.observations || '',
      deliveryType: order.deliveryType || 'delivery',
      tableNumber: order.tableNumber || null,
      source: 'whatsapp',
      senderId: senderId, // Salva o ID do WhatsApp do cliente
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    // Usar o trackingCode como ID do pedido para consistência e fácil busca
    const orderRef = db.ref('tenants/' + username + '/orders/' + trackingCode);
    await orderRef.set({
      ...orderData,
      id: trackingCode // Garante que o ID dentro do objeto seja o mesmo da chave
    });

    return true;
  } catch (error) {
    console.error('❌ Erro ao criar pedido no Firebase:', error);
    return false;
  }
}

// Função para buscar configuração do Firebase
async function getWhatsAppConfig(username) {
  if (!db) {
    console.warn('⚠️ Firebase não inicializado. Usando configuração de exemplo.');
    return { isActive: true, menuUrl: `https://jataifood.vercel.app/pedido/${username}` };
  }

  try {
    const configRef = db.ref('tenants/' + username + '/whatsappConfig');
    const snapshot = await configRef.once('value');
    return snapshot.exists() ? snapshot.val() : null;
  } catch (error) {
    console.error('Erro ao buscar configuração:', error);
    return null;
  }
}

// Função para buscar o último pedido de um cliente
async function getLastOrder(username, senderId) {
  if (!db) {
    console.warn('⚠️ Firebase não inicializado. Não é possível buscar o último pedido.');
    return null;
  }

  try {
    const ordersRef = db.ref('tenants/' + username + '/orders');
    const snapshot = await ordersRef.orderByChild('senderId').equalTo(senderId).limitToLast(1).once('value');
    
    if (snapshot.exists()) {
      const orders = snapshot.val();
      const lastOrderKey = Object.keys(orders)[0];
      console.log('Ultimo pedido encontrado para ' + senderId + ': ' + orders[lastOrderKey].items.map(function(i) { return i.name; }).join(', '));
      return orders[lastOrderKey];
    }
    console.log('Nenhum pedido anterior encontrado para ' + senderId + '.');
    return null;
  } catch (error) {
    console.error('❌ Erro ao buscar último pedido:', error);
    return null;
  }
}

// Função para configurar listener de mensagens
function setupMessageListener(client, username) {
  console.log('📨 Configurando listener de mensagens para ' + username + '.');
  
  client.on('message', async (msg) => {
    console.log('📨 EVENTO MESSAGE DISPARADO!');
    console.log('De:', msg.from);
    console.log('Tipo:', msg.type);
    console.log('Corpo:', msg.body);
    try {
      console.log('🔍 Buscando configuração mais recente no Firebase para:', username);
      const cachedConfig = await getWhatsAppConfig(username);
      
      if (cachedConfig) {
        console.log('🟢 Status do atendimento (cache):', cachedConfig.isActive ? 'Ativo' : 'Inativo');
      }
      
      if (!cachedConfig || !cachedConfig.isActive) {
        console.log('❌ Config não encontrada ou inativa. Ignorando mensagem.');
        return;
      }

      // Ignorar mensagens enviadas pelo próprio bot
      if (msg.fromMe) {
        console.log('❌ Mensagem enviada por mim. Ignorando.');
        return;
      }

      // Processar apenas mensagens de texto
      if (msg.type !== 'chat') {
        console.log('❌ Tipo de mensagem não é chat. Ignorando.');
        return;
      }

      let userMessage = msg.body;
      const userState = conversationState.get(msg.from);
      let contextForGemini = null;

      // Verifica se há um estado de conversa anterior para este usuário
      if (userState) {
        // Se o estado for muito antigo (ex: > 5 minutos), descarta
        if (Date.now() - userState.timestamp > 5 * 60 * 1000) {
          conversationState.delete(msg.from);
        } else {
          // Lógica específica para confirmação de pedido
          if (userState.status === 'awaiting_confirmation' && ['sim', 's', 'isso', 'correto', 'pode confirmar'].includes(msg.body.toLowerCase().trim())) {
            console.log('✅ Cliente confirmou o pedido. Finalizando...');
            // Finaliza o pedido que estava pendente
            await finalizeOrder(client, username, msg, userState.pendingOrder, msg.from);
            conversationState.delete(msg.from); // Limpa o estado
            return; // Encerra o fluxo aqui
          } else if (userState.status === 'awaiting_confirmation' && userState.pendingOrder) {
            // O cliente não confirmou com "sim", então ele provavelmente quer modificar o pedido.
            // Vamos reenviar a mensagem dele para a IA, mas com o contexto do pedido pendente.
            console.log('🔄 Cliente quer modificar o pedido. Reenviando para a IA com contexto.');
            // O prompt da IA já é instruído a lidar com modificações, então apenas passamos a mensagem do usuário.
            // O estado da conversa será limpo naturalmente quando um novo pedido for gerado.
            // Não é necessário adicionar contexto extra aqui, a IA deve inferir a modificação.
          } else if (userState.lastBotMessage) {
             contextForGemini = userState.lastBotMessage;
             conversationState.delete(msg.from);
          }
        }
      }

      console.log('✅ Mensagem processada para ' + msg.from + ': ' + userMessage);
      

      // Processar com Gemini AI
      console.log('📚 Buscando cardápio e informações da loja para dar contexto à IA...');
      const menu = await getMenuFromFirebase(username);
      const businessInfo = await getBusinessInfoFromFirebase(username);
      const lastOrder = await getLastOrder(username, msg.from);

      const menuUrl = cachedConfig.menuUrl || 'https://jataifood.vercel.app/pedido/' + username;
      const aiResponse = await processMessageWithGemini(userMessage, menu, menuUrl, lastOrder, contextForGemini, businessInfo);
      
      // Se a IA falhou (ex: erro de API, 404), aiResponse será null
      if (aiResponse === null) {
        // Notifica o usuário apenas uma vez para evitar spam
        if (!notifiedOfUnavailableAI.has(msg.from)) {
          await client.sendMessage(msg.from, '🤖 Nosso assistente de IA está temporariamente indisponível. Por favor, aguarde que um atendente humano responderá em breve.');
          notifiedOfUnavailableAI.add(msg.from);
        }
        return;
      }
      
      if (!aiResponse || !aiResponse.type || !aiResponse.data) {
        await client.sendMessage(msg.from, 'Desculpe, não consegui entender seu pedido. Por favor, tente novamente com mais detalhes sobre os itens que deseja pedir.\n\nExemplo:\n"Quero 1 pizza grande de calabresa e 1 coca-cola 2L\nEntregar na Rua das Flores, 123\nNome: João\nPagamento: Dinheiro"');
        return;
      }

      // Lógica para tratar diferentes tipos de resposta da IA
      switch (aiResponse.type) {
        case 'order':
          const pendingOrder = aiResponse.data; // Pedido extraído pela IA

          // Busca o cardápio com preços para enriquecer o pedido
          const menuWithPrices = await getMenuWithPrices(username);
          let total = 0;

          if (menuWithPrices) {
            pendingOrder.items.forEach(function(item) {
              // Garante que a quantidade seja sempre um número
              item.quantity = parseInt(item.quantity, 10) || 1;

              const price = menuWithPrices.get(item.name.toLowerCase());
              if (price) {
                item.price = price; // Adiciona o preço ao item
                total += price * (item.quantity || 1); // Calcula o total
              }
            });
          }

          const itemsText = pendingOrder.items.map(function(item) {
            return '- ' + (item.quantity || 1) + 'x ' + item.name + (item.size ? ' (' + item.size + ')' : '') + ' (R$ ' + (item.price ? item.price.toFixed(2) : '??') + ')';
          }).join('\n');
          const confirmationQuestion = 'Confirme seu pedido, por favor:\n\n*Itens:*\n' + 
            itemsText + '\n\n*Total estimado: R$ ' + total.toFixed(2) + 
            '*\n\nEstá correto? (Responda com "sim" para confirmar)';
          
          // Salva o pedido pendente no estado da conversa
          conversationState.set(msg.from, { 
            status: 'awaiting_confirmation', 
            pendingOrder: pendingOrder, 
            timestamp: Date.now() 
          });

          await client.sendMessage(msg.from, confirmationQuestion);
          break;

        case 'reply':
        case 'clarification':
          console.log('💬 IA gerou uma resposta de conversação:', aiResponse.data);
          // Se a resposta for uma pergunta, armazena no estado da conversa
          if (aiResponse.type === 'clarification') {
            conversationState.set(msg.from, { lastBotMessage: aiResponse.data, timestamp: Date.now() });
            console.log('📝 Estado da conversa salvo para ' + msg.from);
          }
          await client.sendMessage(msg.from, aiResponse.data);
          break;

        default:
          console.log('❓ Tipo de resposta desconhecido da IA: ' + aiResponse.type);
          await client.sendMessage(msg.from, 'Desculpe, não consegui processar a resposta. Poderia tentar novamente?');
          break;
      }
      console.log('✅ Resposta enviada com sucesso!');

    } catch (error) {
      console.error('❌ Erro ao processar mensagem:', error);
      try { // Tenta enviar uma mensagem de erro genérica para o cliente
        await client.sendMessage(msg.from, 'Desculpe, ocorreu um erro ao processar sua mensagem. Por favor, tente novamente mais tarde.');
      } catch (replyError) {
        console.error('❌ Erro ao enviar resposta de erro:', replyError);
      }
    }
  });
  
  console.log('✅ Listener de mensagens configurado com sucesso!');
}

// Nova função para finalizar o pedido após a confirmação
async function finalizeOrder(client, username, msg, order, senderId) {
  try {
    const trackingCode = generateTrackingCode();
    const orderCreated = await createOrderInFirebase(username, order, trackingCode, senderId);

    if (!orderCreated) {
      await client.sendMessage(msg.from, 'Desculpe, ocorreu um erro ao salvar seu pedido. Por favor, tente novamente.');
      return;
    }

    let total = 0;
    const itemsList = order.items.map(function(item) {
        const price = typeof item.price === 'number' ? item.price : 0;
        const quantity = typeof item.quantity === 'number' ? item.quantity : 0;
        total += price * quantity;
        return '- ' + quantity + 'x ' + item.name + (item.size ? ' (' + item.size + ')' : '') + ' (R$ ' + price.toFixed(2) + ')';
    }).join('\n');

    const finalConfirmationMessage = [
      '✅ *Pedido confirmado!*',
      '',
      '*Código de rastreamento:* ' + trackingCode,
      '',
      '*Itens:*',
      itemsList,
      '',
      '*Total: R$ ' + total.toFixed(2) + '*',
      '',
      '*Endereço:* ' + (order.address || 'A definir'),
      '*Pagamento:* ' + (order.paymentMethod || 'A definir'),
      '',
      'Seu pedido foi recebido e está sendo preparado! 🍕',
      '',
      'Você pode acompanhar o status do seu pedido em:',
      'https://jataifood.vercel.app/rastreamento/' + trackingCode,
      '',
      'Obrigado por escolher o JataíFood! 😊'
    ].join('\n');

    await client.sendMessage(msg.from, finalConfirmationMessage);
  } catch (error) {
    console.error('❌ Erro ao finalizar pedido:', error);
    await client.sendMessage(msg.from, 'Ocorreu um erro ao finalizar seu pedido.');
  }
}

// Função para inicializar cliente WhatsApp
async function initializeWhatsAppClient(username) {
  try {
    if (whatsappClients.has(username)) {
      const oldClient = whatsappClients.get(username);
      await oldClient.destroy();
      whatsappClients.delete(username);
    }

    // Criar novo cliente
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: username,
        dataPath: './whatsapp-sessions/' + username
      }),
      puppeteer: {
        headless: true, // Alterado para 'true' para melhor performance e compatibilidade com servidores
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', // Caminho para uma instalação estável do Chrome
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-extensions',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      }
    });

    // Evento: QR Code gerado
    client.on('qr', async (qr) => {
      console.log('QR Code gerado para ' + username);
      try {
        const qrDataUrl = await qrcode.toDataURL(qr);
        qrCodes.set(username, qrDataUrl);
        connectionStatus.set(username, 'qr_code');
      } catch (err) {
        console.error('Erro ao gerar QR code:', err);
      }
    });

    // Evento: Cliente pronto
    client.on('ready', () => {
      console.log('✅ WhatsApp conectado para ' + username);
      console.log('🔊 Registrando listener de mensagens...');
      connectionStatus.set(username, 'connected');
      qrCodes.delete(username);
      
      // Registrar listener de mensagens DEPOIS que o cliente está pronto
      setupMessageListener(client, username);
    });

    // Evento: Autenticação
    client.on('authenticated', () => {
      console.log('WhatsApp autenticado para ' + username);
      connectionStatus.set(username, 'authenticated');
    });

    // Evento: Falha na autenticação
    client.on('auth_failure', (msg) => {
      console.error('Falha na autenticação para ' + username + ':', msg);
      connectionStatus.set(username, 'auth_failure');
    });

    // Evento: Desconectado
    client.on('disconnected', (reason) => {
      console.log('WhatsApp desconectado para ' + username + ':', reason);
      connectionStatus.set(username, 'disconnected');
      whatsappClients.delete(username);
    });

    // Listener de mensagens será registrado no evento 'ready'

    // Inicializar cliente
    await client.initialize();
    whatsappClients.set(username, client);
    connectionStatus.set(username, 'initializing');

    return true;

  } catch (error) {
    console.error('Erro ao inicializar cliente WhatsApp para ' + username + ':', error);
    connectionStatus.set(username, 'error');
    return false;
  }
}

// Rotas da API

// Iniciar conexão WhatsApp
app.post('/api/whatsapp/start/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    // Verificar se já está conectado
    if (whatsappClients.has(username)) {
      const status = connectionStatus.get(username);
      return res.json({
        success: true, 
        message: 'Already connected',
        status 
      });
    }

    // Inicializar cliente
    await initializeWhatsAppClient(username);

    res.json({
      success: true, 
      message: 'WhatsApp client initialized',
      status: 'initializing'
    });

  } catch (error) {
    console.error('Erro ao iniciar WhatsApp:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Obter QR Code
app.get('/api/whatsapp/qr/:username', (req, res) => {
  try {
    const { username } = req.params;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const qr = qrCodes.get(username);
    const status = connectionStatus.get(username) || 'disconnected';

    if (qr) {
      res.json({ qr, status });
    } else {
      res.json({ qr: null, status });
    }

  } catch (error) {
    console.error('Erro ao obter QR code:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Obter status da conexão
app.get('/api/whatsapp/status/:username', (req, res) => {
  try {
    const { username } = req.params;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const status = connectionStatus.get(username) || 'disconnected';
    const isConnected = whatsappClients.has(username);

    res.json({
      status,
      isConnected,
      hasQrCode: qrCodes.has(username)
    });

  } catch (error) {
    console.error('Erro ao obter status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Desconectar WhatsApp
app.post('/api/whatsapp/disconnect/:username', async (req, res) => {
  try {
    const { username } = req.params;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    const client = whatsappClients.get(username);
    
    if (client) {
      await client.destroy();
      whatsappClients.delete(username);
      qrCodes.delete(username);
      connectionStatus.set(username, 'disconnected');
    }

    res.json({
      success: true, 
      message: 'WhatsApp disconnected' 
    });

  } catch (error) {
    console.error('Erro ao desconectar WhatsApp:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('🚀 Servidor WhatsApp rodando na porta ' + PORT);
  console.log('📱 Endpoints disponíveis:');
  console.log('   POST /api/whatsapp/start/:username - Iniciar conexão');
  console.log('   GET  /api/whatsapp/qr/:username - Obter QR Code');
  console.log('   GET  /api/whatsapp/status/:username - Obter status');
  console.log('   POST /api/whatsapp/disconnect/:username - Desconectar');
});
