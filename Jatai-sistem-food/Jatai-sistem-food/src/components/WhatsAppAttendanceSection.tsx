import React, { useState, useEffect } from 'react';
import { MessageCircle, Save, RefreshCw, AlertCircle, Phone, Power, QrCode, Wifi, WifiOff, Link } from 'lucide-react';
import { toast } from 'sonner';
import { ref, set, get } from 'firebase/database';
import { database } from '../config/firebase';

interface WhatsAppConfig {
  isActive: boolean;
  phoneNumber?: string;
  menuUrl?: string;
  hours?: string;
  address?: string;
}


interface ConnectionStatus {
  status: 'disconnected' | 'initializing' | 'qr_code' | 'authenticated' | 'connected' | 'auth_failure' | 'error';
  isConnected: boolean;
  hasQrCode: boolean;
}

const WHATSAPP_SERVER_URL = import.meta.env.VITE_WHATSAPP_SERVER_URL || 'http://localhost:3001';

const WhatsAppAttendanceSection: React.FC = () => {
  const username = localStorage.getItem('username') || 'A';
  const [config, setConfig] = useState<WhatsAppConfig>({
    isActive: false,
    phoneNumber: '',
    menuUrl: '',
    hours: '',
    address: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    status: 'disconnected',
    isConnected: false,
    hasQrCode: false
  });
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    loadConfig();
    checkConnectionStatus();

    // O polling só deve rodar se a conexão não estiver estabelecida.
    if (connectionStatus.status !== 'connected') {
      const interval = setInterval(() => {
        // Se já conectou, para de verificar.
        if (connectionStatus.status === 'connected') {
          clearInterval(interval);
          return;
        }

        // Busca o QR code apenas se estiver no estado de QR ou inicializando.
        if (connectionStatus.status === 'qr_code' || connectionStatus.status === 'initializing') {
          fetchQrCode();
        }
        checkConnectionStatus();
      }, 5000); // Aumentado para 5 segundos para reduzir a carga.

      return () => clearInterval(interval);
    }
  }, [username, connectionStatus.status]); // Adicionado connectionStatus.status como dependência

  const loadConfig = async () => {
    if (!username) return;
    
    setIsLoading(true);
    try {
      const configRef = ref(database, `tenants/${username}/whatsappConfig`);
      const snapshot = await get(configRef);
      
      if (snapshot.exists()) {
        const data = snapshot.val();
        setConfig(data);
      }
    } catch (error) {
      console.error('Erro ao carregar configuração:', error);
      toast.error('Erro ao carregar configurações do WhatsApp');
    } finally {
      setIsLoading(false);
    }
  };

  const saveConfig = async () => {
    console.log('🔥 SAVE CONFIG CHAMADO!');
    console.log('Username:', username);
    console.log('Config atual:', config);
    
    if (!username) {
      console.log('❌ Username não encontrado!');
      return;
    }
    
    // Validações
    if (!config.phoneNumber && !config.hours && !config.address) {
      console.log('❌ Número do WhatsApp não preenchido');
      toast.error('Por favor, insira o número do WhatsApp');
      return;
    }
    
    console.log('✅ Validações passaram! Iniciando salvamento...');
    setIsSaving(true);
    try {      
      const dataToSave = {
        isActive: config.isActive,
        phoneNumber: config.phoneNumber || '',
        menuUrl: config.menuUrl || '',
        hours: config.hours || '',
        address: config.address || '',
        updatedAt: new Date().toISOString()
      };
      
      // Salvar em whatsappConfig
      const whatsappConfigRef = ref(database, `tenants/${username}/whatsappConfig`);
      await set(whatsappConfigRef, dataToSave);

      console.log('💾 Dados a salvar:', dataToSave);
      
      console.log('✅ Salvo com sucesso no Firebase!');
      toast.success('Configurações salvas com sucesso!');
    } catch (error) {
      console.error('❌ Erro ao salvar configuração:', error);
      toast.error('Erro ao salvar configurações');
    } finally {
      setIsSaving(false);
      console.log('🏁 SaveConfig finalizado');
    }
  };

  const handleToggleActive = async (isActive: boolean) => {
    // Atualiza o estado local imediatamente para feedback visual
    const newConfig = { ...config, isActive };
    setConfig(newConfig);

    // Salva apenas a alteração do 'isActive' no Firebase
    try {
      const activeRef = ref(database, `tenants/${username}/whatsappConfig/isActive`);
      await set(activeRef, isActive);
      toast.success(`Atendimento ${isActive ? 'ativado' : 'desativado'}!`);
      console.log(`✅ Status do atendimento alterado para: ${isActive}`);
    } catch (error) {
      console.error('❌ Erro ao atualizar status de atendimento:', error);
      toast.error('Erro ao alterar status do atendimento.');
      // Reverte a alteração visual em caso de erro
      setConfig({ ...config, isActive: !isActive });
    }
  };

  const checkConnectionStatus = async () => {
    if (!username) return;
    
    try {
      const response = await fetch(`${WHATSAPP_SERVER_URL}/api/whatsapp/status/${username}`);
      if (response.ok) {
        const data = await response.json();
        setConnectionStatus(data);
      }
    } catch (error) {
      console.error('Erro ao verificar status:', error);
    }
  };

  const fetchQrCode = async () => {
    if (!username) return;
    
    try {
      const response = await fetch(`${WHATSAPP_SERVER_URL}/api/whatsapp/qr/${username}`);
      if (response.ok) {
        const data = await response.json();
        if (data.qr) {
          setQrCode(data.qr);
        } else {
          setQrCode(null);
        }
      }
    } catch (error) {
      console.error('Erro ao buscar QR code:', error);
    }
  };

  const connectWhatsApp = async () => {
    if (!username) return;
    
    setIsConnecting(true);
    try {
      const response = await fetch(`${WHATSAPP_SERVER_URL}/api/whatsapp/start/${username}`, {
        method: 'POST'
      });

      if (response.ok) {
        toast.success('Iniciando conexão com WhatsApp...');
        // A verificação de status agora é imediata e o polling cuidará de buscar o QR code.
        await checkConnectionStatus();
      } else {
        toast.error('Erro ao iniciar conexão');
      }
    } catch (error) {
      console.error('Erro ao conectar WhatsApp:', error);
      toast.error('Erro ao conectar. Verifique se o servidor está rodando.');
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnectWhatsApp = async () => { // Tornando a função async
    if (!username) return;
    
    toast.info('Desconectando WhatsApp...');
    try {
      const response = await fetch(`${WHATSAPP_SERVER_URL}/api/whatsapp/disconnect/${username}`, {
        method: 'POST'
      });

      if (response.ok) {
        toast.success('WhatsApp desconectado com sucesso!');
        setQrCode(null);
        // Atualiza o estado para refletir a desconexão imediatamente
        setConnectionStatus({
          status: 'disconnected',
          isConnected: false,
          hasQrCode: false
        });
        // Uma verificação final para garantir que o status do servidor está sincronizado.
        await checkConnectionStatus(); 
      } else {
        toast.error('Ocorreu um erro no servidor ao tentar desconectar.');
      }
    } catch (error) {
      console.error('Erro ao desconectar WhatsApp:', error);
      toast.error('Não foi possível conectar ao servidor para desconectar.');
    }
  };

  const formatPhoneNumber = (value: string) => {
    const numbers = value.replace(/\D/g, '');
    
    if (numbers.length <= 2) {
      return numbers;
    } else if (numbers.length <= 7) {
      return `(${numbers.slice(0, 2)}) ${numbers.slice(2)}`;
    } else if (numbers.length <= 11) {
      return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 7)}-${numbers.slice(7)}`;
    }
    return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 7)}-${numbers.slice(7, 11)}`;
  };

  const getStatusColor = () => {
    switch (connectionStatus.status) {
      case 'connected': return 'green';
      case 'authenticated': return 'blue';
      case 'qr_code': return 'yellow';
      case 'initializing': return 'yellow';
      case 'auth_failure': return 'red';
      case 'error': return 'red';
      default: return 'gray';
    }
  };

  const getStatusText = () => {
    switch (connectionStatus.status) {
      case 'connected': return 'Conectado';
      case 'authenticated': return 'Autenticado';
      case 'qr_code': return 'Aguardando leitura do QR Code';
      case 'initializing': return 'Inicializando...';
      case 'auth_failure': return 'Falha na autenticação';
      case 'error': return 'Erro';
      default: return 'Desconectado';
    }
  };

  const getStatusIcon = () => {
    if (connectionStatus.isConnected) {
      return <Wifi className="h-8 w-8 text-green-600" />;
    } else {
      return <WifiOff className="h-8 w-8 text-gray-400" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-md p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-3 bg-green-100 rounded-full">
            <MessageCircle className="h-6 w-6 text-green-600" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-800">Atendimento WhatsApp</h2>
            <p className="text-gray-600">Configure a integração com WhatsApp Web e IA Gemini para receber pedidos automaticamente</p>
          </div>
        </div>
      </div>

      {/* Connection Status Card */}
      <div className={`rounded-lg shadow-md p-6 border-2 ${
        connectionStatus.isConnected 
          ? 'bg-green-50 border-green-200' 
          : 'bg-gray-50 border-gray-200'
      }`}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            {getStatusIcon()}
            <div>
              <h3 className="text-lg font-semibold text-gray-800">
                Status: {getStatusText()}
              </h3>
              <p className="text-sm text-gray-600">
                {connectionStatus.isConnected 
                  ? 'O WhatsApp está conectado e funcionando' 
                  : 'Conecte seu WhatsApp para começar a receber pedidos'}
              </p>
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              checked={config.isActive}
              onChange={(e) => handleToggleActive(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-14 h-7 bg-gray-300 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-green-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-green-600"></div>
          </label>
        </div>

        {/* QR Code Display */}
        {connectionStatus.status === 'qr_code' && qrCode && (
          <div className="mt-4 p-4 bg-white rounded-lg border-2 border-yellow-300">
            <div className="flex flex-col items-center">
              <div className="flex items-center gap-2 mb-3">
                <QrCode className="h-5 w-5 text-yellow-600" />
                <h4 className="text-lg font-semibold text-gray-800">Escaneie o QR Code</h4>
              </div>
              <img src={qrCode} alt="QR Code WhatsApp" className="w-64 h-64 border-4 border-gray-200 rounded-lg" />
              <p className="text-sm text-gray-600 mt-3 text-center">
                Abra o WhatsApp no seu celular → Dispositivos conectados → Conectar um dispositivo
              </p>
              <div className="flex items-center gap-2 mt-2 text-yellow-600">
                <RefreshCw className="h-4 w-4 animate-spin" />
                <span className="text-sm">Aguardando leitura...</span>
              </div>
            </div>
          </div>
        )}

        {/* Connection Buttons */}
        <div className="mt-4 flex gap-3">
          {!connectionStatus.isConnected ? (
            <button
              onClick={connectWhatsApp} // Removida a dependência da chave Gemini
              disabled={isConnecting}
              className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Power className="h-5 w-5" />
              {isConnecting ? 'Conectando...' : 'Conectar WhatsApp'}
            </button>
          ) : (
            <button
              onClick={disconnectWhatsApp}
              className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors"
            >
              <Power className="h-5 w-5" />
              Desconectar WhatsApp
            </button>
          )}
        </div>
      </div>

      {/* Configuration Form */}
      <div className="bg-white rounded-lg shadow-md p-6 space-y-6">
        <h3 className="text-xl font-semibold text-gray-800 mb-4">Configurações</h3>
        
        {/* Phone Number */}
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
            <Phone className="h-4 w-4" />
            Número do WhatsApp
          </label>
          <input
            type="text"
            value={config.phoneNumber || ''}
            onChange={(e) => setConfig({ ...config, phoneNumber: formatPhoneNumber(e.target.value) })}
            placeholder="(64) 99999-9999"
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-500 mt-1">
            Digite o número do WhatsApp que receberá os pedidos
          </p>
        </div>

        {/* Horário de Funcionamento */}
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
            <Phone className="h-4 w-4" />
            Horário de Funcionamento
          </label>
          <input
            type="text"
            value={config.hours || ''}
            onChange={(e) => setConfig({ ...config, hours: e.target.value })}
            placeholder="Seg a Sex: 18h às 23h, Sáb e Dom: 18h às 00h"
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
        </div>

        {/* Endereço */}
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
            <Phone className="h-4 w-4" />
            Endereço
          </label>
          <input
            type="text"
            value={config.address || ''}
            onChange={(e) => setConfig({ ...config, address: e.target.value })}
            placeholder="Rua das Flores, 123, Centro"
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-500 mt-1">
            Digite o número do WhatsApp que receberá os pedidos
          </p>
        </div>

        {/* Menu URL */}
        <div>
          <label className="flex items-center gap-2 text-sm font-medium text-gray-700 mb-2">
            <Link className="h-4 w-4" />
            Link do Cardápio/Página de Pedidos
          </label>
          <input
            type="url"
            value={config.menuUrl || ''}
            onChange={(e) => setConfig({ ...config, menuUrl: e.target.value })}
            placeholder="https://seu-site.com/pedido"
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          <p className="text-xs text-gray-500 mt-1">
            Este é o link que o agente enviará quando o cliente pedir o cardápio.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-3 pt-4">
          <button
            onClick={saveConfig}
            disabled={isSaving}
            className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="h-5 w-5" />
            {isSaving ? 'Salvando...' : 'Salvar Configurações'}
          </button>
        </div>
      </div>

      {/* Instructions */}
      <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-blue-900 mb-3">Como funciona?</h3>
        <ol className="space-y-2 text-sm text-blue-800">
          <li className="flex gap-2">
            <span className="font-bold">1.</span>
            <span>Configure seu número do WhatsApp e o link do cardápio acima</span>
          </li>
          <li className="flex gap-2">
            <span className="font-bold">2.</span>
            <span>Clique em "Salvar Configurações"</span>
          </li>
            <li className="flex gap-2">
            <span className="font-bold">4.</span>
            <span>Ative o atendimento usando o botão de toggle</span>
          </li>
          <li className="flex gap-2">
            <span className="font-bold">5.</span>
            <span>Quando um cliente enviar uma mensagem, a IA Gemini processará o pedido e criará automaticamente no sistema</span>
          </li>
        </ol>
      </div>
    
      {/* Server Status Warning */}
      {!connectionStatus.isConnected && (
        <div className="bg-yellow-50 border-2 border-yellow-200 rounded-lg p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5" />
            <div>
              <h4 className="font-semibold text-yellow-900 mb-1">Servidor WhatsApp necessário</h4>
              <p className="text-sm text-yellow-800">
                Para usar esta funcionalidade, você precisa ter o servidor Node.js rodando. Execute: <code className="bg-yellow-100 px-2 py-1 rounded">node server/whatsapp-server.js</code>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WhatsAppAttendanceSection;