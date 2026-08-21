// Arquivo de Configuração Local
// Altere os valores abaixo de acordo com as necessidades do seu projeto.
window.APP_CONFIG = {
  // Insira a URL gerada pelo seu webhook do n8n para receber os dados em formato JSON
  N8N_WEBHOOK_URL: 'http://localhost:5678/webhook/cotacao-lead',

  // Se ativado como true, após salvar os dados no webhook, o site redirecionará
  // o usuário para o WhatsApp com a mensagem pronta de cotação.
  // Se definido como false, apenas exibirá a tela de sucesso no site.
  REDIRECT_TO_WHATSAPP: false,

  // Números do WhatsApp para atendimento (sem espaços ou formatação, com DDI + DDD)
  WHATSAPP_CONTACT_1: '5561985475886',
  WHATSAPP_CONTACT_2: '5561981731700'
};
