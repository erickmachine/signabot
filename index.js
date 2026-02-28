const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const yts = require('yt-search');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

// ============================================================
// SIGNABOT - Bot WhatsApp Completo
// ============================================================

const PREFIXES = ['#', '/', '!'];
const BOT_NAME = 'SignaBot';
const OWNER_NUMBER = '5592999652961';

// ========== ADICIONADO: Número do bot que aparece nos logs ==========
const BOT_NUMBER = '557183477259'; // Número do bot que aparece nos logs

// ========== CORREÇÃO: Lista de JIDs do dono com número do bot ==========
const OWNER_JIDS = [
  `${OWNER_NUMBER}@s.whatsapp.net`,
  '559299652961@s.whatsapp.net',
  `${BOT_NUMBER}@s.whatsapp.net`,
  '212171434754106@lid' // Formato que aparece nos logs
];

// ========== FUNÇÃO ISOWNER CORRIGIDA ==========
const isOwner = (sender) => {
  // Verificar se o sender está na lista de JIDs do dono
  const isInList = OWNER_JIDS.includes(sender);
  
  // Extrair apenas números do sender (remover @lid, @s.whatsapp.net, etc.)
  let senderNumber = sender.split('@')[0];
  senderNumber = senderNumber.replace(/\D/g, '');
  
  // Números para comparação (apenas dígitos)
  const ownerNumber = OWNER_NUMBER.replace(/\D/g, '');
  const botNumber = BOT_NUMBER.replace(/\D/g, '');
  
  // Verificar se o número corresponde ao dono ou ao bot
  const isNumberMatch = senderNumber === ownerNumber || senderNumber === botNumber;
  
  // Log para debug
  console.log(`[DEBUG] Verificando dono:`);
  console.log(`[DEBUG] Sender original: ${sender}`);
  console.log(`[DEBUG] Sender número limpo: ${senderNumber}`);
  console.log(`[DEBUG] Dono número: ${ownerNumber}`);
  console.log(`[DEBUG] Bot número: ${botNumber}`);
  console.log(`[DEBUG] Na lista de JIDs? ${isInList}`);
  console.log(`[DEBUG] Número match? ${isNumberMatch}`);
  console.log(`[DEBUG] É dono? ${isInList || isNumberMatch}`);
  
  return isInList || isNumberMatch;
};

// ============================================================
// BANCO DE DADOS JSON LOCAL
// ============================================================

const DATA_DIR = path.join(__dirname, 'database');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const loadDB = (name) => {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) { fs.writeFileSync(file, '{}'); return {}; }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
};

const saveDB = (name, data) => {
  const file = path.join(DATA_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// Carrega todos os bancos
let subscriptions = loadDB('subscriptions');
let warnings      = loadDB('warnings');
let blacklist     = loadDB('blacklist');
let groupSettings = loadDB('groupSettings');
let userActivity  = loadDB('userActivity');
let schedules     = loadDB('schedules');
let notes         = loadDB('notes');
let birthdays     = loadDB('birthdays');
let muted         = loadDB('muted');
let cargos        = loadDB('cargos');       // { groupId: { userId: 'admin'|'mod'|'aux' } }
let afkList       = loadDB('afkList');      // { userId: { msg, time } }
let autoMessages  = loadDB('autoMessages'); // mensagens automáticas agendadas
let rules         = loadDB('rules');        // { groupId: 'texto das regras' }
let customCmds    = loadDB('customCmds');   // { groupId: { cmdName: { text, image, creator } } }
let privateConfig = loadDB('privateConfig'); // { oderId: { selectedGroup, step } }
let botLogs       = loadDB('botLogs');       // { errors: [], actions: [] }
let groupHistory  = loadDB('groupHistory');  // { groupId: { hadTrial, hadPaid, ownerNumbers: [] } }

// Inicializar logs se necessário
if (!botLogs.errors) botLogs.errors = [];
if (!botLogs.actions) botLogs.actions = [];

// Função para registrar erros do bot
const logBotError = (context, error) => {
  botLogs.errors.push({
    time: Date.now(),
    context,
    error: error?.message || String(error),
    stack: error?.stack?.split('\n').slice(0, 3).join(' | ') || ''
  });
  // Manter apenas os últimos 100 erros
  if (botLogs.errors.length > 100) botLogs.errors = botLogs.errors.slice(-100);
  saveDB('botLogs', botLogs);
};

// Função para registrar ações do bot
const logBotAction = (action, details) => {
  botLogs.actions.push({
    time: Date.now(),
    action,
    details
  });
  // Manter apenas as últimas 200 ações
  if (botLogs.actions.length > 200) botLogs.actions = botLogs.actions.slice(-200);
  saveDB('botLogs', botLogs);
};

// ============================================================
// HISTÓRICO DE GRUPOS (anti-burla de trial)
// ============================================================

// Registra que um grupo teve trial ou assinatura paga, e qual número era do criador/participante
const markGroupHistory = (groupId, type, senderNumber) => {
  if (!groupHistory[groupId]) {
    groupHistory[groupId] = { hadTrial: false, hadPaid: false, ownerNumbers: [] };
  }
  if (type === 'trial') groupHistory[groupId].hadTrial = true;
  if (type === 'paid' || type === 'premium') groupHistory[groupId].hadPaid = true;
  if (senderNumber && !groupHistory[groupId].ownerNumbers.includes(senderNumber)) {
    groupHistory[groupId].ownerNumbers.push(senderNumber);
  }
  saveDB('groupHistory', groupHistory);
};

// Verifica se um grupo ou número já usou trial/assinatura antes
const groupOrNumberHasHistory = (groupId, senderNumber) => {
  const hist = groupHistory[groupId];
  if (hist && (hist.hadTrial || hist.hadPaid)) return true;
  // Verificar se o número já apareceu em outro grupo com histórico
  if (senderNumber) {
    for (const [, h] of Object.entries(groupHistory)) {
      if (h.ownerNumbers && h.ownerNumbers.includes(senderNumber)) return true;
    }
  }
  return false;
};

// ============================================================
// HELPERS GERAIS
// ============================================================

const isAdmin = async (sock, groupId, userId) => {
  try {
    const meta = await sock.groupMetadata(groupId);
    const p = meta.participants.find((x) => x.id === userId);
    return p && (p.admin === 'admin' || p.admin === 'superadmin');
  } catch { return false; }
};

const getCargo = (groupId, userId) => {
  if (!cargos[groupId]) return null;
  return cargos[groupId][userId] || null;
};

const hasCargo = (groupId, userId, ...allowed) => {
  const c = getCargo(groupId, userId);
  return allowed.includes(c);
};

const getGroupSettings = (groupId) => {
  if (!groupSettings[groupId]) {
    groupSettings[groupId] = {
      antilink: false,
      antilinkAllow: ['instagram.com', 'youtube.com', 'youtu.be', 'tiktok.com'],
      welcome: true,
      welcomeMsg: '',
      leaveMsg: '',
      antiSpam: false,
      autoBaixar: false,
      simih: false,
      antiPalavra: false,
      palavroes: [],
      antiImg: false,
      antiVideo: false,
      antiAudio: false,
      antiDoc: false,
      antiSticker: false,
      antiContato: false,
      antiLoc: false,
      antiVendas: false,
      soAdm: false,
      mute: false,
      openAt: null,
      closeAt: null,
      warningLimit: 3,
      antiViewOnce: false,
    };
    saveDB('groupSettings', groupSettings);
  }
  return groupSettings[groupId];
};

const saveSettings = () => saveDB('groupSettings', groupSettings);

// ========== FUNÇÃO CHECKSUBSCRIPTION CORRIGIDA ==========
const checkSubscription = (groupId) => {
  const sub = subscriptions[groupId];
  if (!sub) return { active: false, reason: 'Sem assinatura. Entre em contato: wa.me/' + OWNER_NUMBER };
  const now = Date.now();
  if (now > sub.expiresAt) return { active: false, reason: sub.type === 'trial' ? 'Teste gratis expirado' : 'Assinatura expirada' };
  return { active: true, type: sub.type, expiresAt: sub.expiresAt };
};

const formatTime = (ms) => {
  if (ms <= 0) return 'Expirado';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${d}d ${h}h ${m}m`;
};

const logActivity = (groupId, userId) => {
  if (!userActivity[groupId]) userActivity[groupId] = {};
  const u = userActivity[groupId][userId] || { messageCount: 0, lastActive: 0 };
  u.messageCount++;
  u.lastActive = Date.now();
  userActivity[groupId][userId] = u;
  saveDB('userActivity', userActivity);
};

const getMentioned = (message) =>
  message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

const getQuoted = (message) =>
  message.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;

const getQuotedSender = (message) =>
  message.message?.extendedTextMessage?.contextInfo?.participant || null;

// Download de mídia via Baileys
const downloadMedia = async (msgContent, type) => {
  try {
    const stream = await downloadContentFromMessage(msgContent, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return buffer;
  } catch { return null; }
};

// ============================================================
// HANDLER DE COMANDOS
// ============================================================

const handleCommand = async (sock, message, groupId, sender, command, args, isGroup) => {
  const senderName = message.pushName || sender.split('@')[0];
  const reply = (text) => sock.sendMessage(groupId, { text }, { quoted: message });
  const replyImg = (buffer, caption) => sock.sendMessage(groupId, { image: buffer, caption }, { quoted: message });
  const adminCheck = isGroup ? await isAdmin(sock, groupId, sender) : false;
  const ownerCheck = isOwner(sender);
  const cargoCheck = (groupId, ...c) => ownerCheck || adminCheck || hasCargo(groupId, sender, ...c);

  // Log do comando para debug
  console.log(`[COMANDO] ${command} de ${sender} - Dono: ${ownerCheck}`);

  // Verificar assinatura (pular comandos de assinatura e info)
  const skipSubCheck = [
    '#ativar', '#status', '#cancelar', '#trial',
    '#ping', '#info', '#dono', '#menu', '#sender', '#horario', '#feedback',
    '#dicatech', '#vercomandos', '#listacmd'
  ].includes(command) || ownerCheck;

  if (isGroup && !skipSubCheck) {
    const sub = checkSubscription(groupId);
    if (!sub.active) {
      return reply(`⚠️ Aviso: ${sub.reason}. Entre em contato com o dono para ativar.`);
    }
  }

  const settings = isGroup ? getGroupSettings(groupId) : {};

  // ===========================================================
// ASSINATURA (dono) - VERSÃO CORRIGIDA COM # E !
// ===========================================================

if (command === '#ativar') {
  console.log(`[ATIVAR] Executando comando de ativação`);
  
  if (!ownerCheck) {
    console.log(`[ATIVAR] NEGADO - Não é o dono`);
    return reply('❌ Sem permissao.');
  }
  
  if (!isGroup) return reply('❌ Use em um grupo.');
  
  const days = parseInt(args[0]);
  if (![7, 15, 30, 60, 90].includes(days)) return reply('❌ Use: !ativar [7|15|30|60|90] dias');
  
  const expiresAt = Date.now() + days * 86400000;
  subscriptions[groupId] = { type: 'paid', activatedAt: Date.now(), expiresAt, days };
  saveDB('subscriptions', subscriptions);
  markGroupHistory(groupId, 'paid', sender.split('@')[0]);
  
  console.log(`[ATIVAR] Assinatura ativada para ${groupId} até ${new Date(expiresAt).toLocaleString('pt-BR')}`);
  
  return reply(`✅ Assinatura ativada por ${days} dias!\nExpira em: ${new Date(expiresAt).toLocaleString('pt-BR')}`);
}

if (command === '#trial') {
  if (!ownerCheck) return reply('❌ Sem permissao.');
  if (!isGroup) return reply('❌ Use em um grupo.');
  const mins = parseInt(args[0]) || 10;
  subscriptions[groupId] = { type: 'trial', activatedAt: Date.now(), expiresAt: Date.now() + mins * 60000 };
  saveDB('subscriptions', subscriptions);
  markGroupHistory(groupId, 'trial', sender.split('@')[0]);
  return reply(`✅ Teste de ${mins} minuto(s) ativado!`);
}

if (command === '#cancelar') {
  if (!ownerCheck) return reply('❌ Sem permissao.');
  if (subscriptions[groupId]) {
    markGroupHistory(groupId, subscriptions[groupId].type || 'paid', sender.split('@')[0]);
    delete subscriptions[groupId];
    saveDB('subscriptions', subscriptions);
  }
  return reply('✅ Assinatura cancelada.');
}

if (command === '#status') {
  if (!isGroup) return reply('❌ Use em um grupo.');
  const sub = checkSubscription(groupId);
  if (!sub.active) return reply(`📊 Status: ${sub.reason}`);
  const left = sub.expiresAt - Date.now();
  return reply(`📊 *Status da Assinatura*\n\nTipo: ${sub.type === 'trial' ? 'Teste' : 'Pago'}\nRestante: ${formatTime(left)}\nExpira: ${new Date(sub.expiresAt).toLocaleString('pt-BR')}`);
}

  // ===========================================================
  // MENU PRINCIPAL - VERSÃO BONITA
  // ===========================================================

  if (command === '#menu') {
    const sub = args[0]?.toLowerCase();
    const dataAtual = new Date().toLocaleDateString('pt-BR');
    const horaAtual = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    if (!sub) {
      const menuPrincipal = `
╔══════════════════╗
     🤖 MENU PRINCIPAL 🤖
╚══════════════════╝

👤 *USUÁRIO*
➤ Nome: ${senderName}
➤ Data: ${dataAtual}
➤ Hora: ${horaAtual}
➤ Prefixos: # / !

📌 *MENUS DISPONÍVEIS*
➤ #menu figurinhas
➤ #menu download
➤ #menu admin
➤ #menu diversão
➤ #menu grupo
➤ #menu info
➤ #menu gold
➤ #menu tecnologia
➤ #menu comandos

⚡ *COMANDOS RÁPIDOS*
➤ #ping
➤ #dono
➤ !status

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
      `;
      return reply(menuPrincipal);
    }

    // ===========================================================
    // MENU FIGURINHAS
    // ===========================================================
    if (sub === 'figurinhas' || sub === 'fig') {
      return reply(`
╔══════════════════╗
     📦 MENU FIGURINHAS 📦
╚══════════════════╝

🖼️ *CRIAR FIGURINHA*
➤ #sticker
➤ #fig
➤ #s

📝 *TEXTO PARA FIGURINHA*
➤ #ttp [texto]
➤ #attp [texto]

🔄 *CONVERSORES*
➤ #toimg
➤ #togif

✏️ *EDIÇÃO*
➤ #take [autor] [pack]

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU DOWNLOAD
    // ===========================================================
    if (sub === 'download') {
      return reply(`
╔══════════════════╗
     📥 MENU DOWNLOAD 📥
╚══════════════════╝

▶️ *YOUTUBE*
➤ #play [nome/url]
➤ #playvideo [nome]
➤ #ytsearch [busca]

📱 *TIKTOK*
➤ #tiktok [url]

📸 *INSTAGRAM*
➤ #instagram [url]

🎵 *MÚSICAS*
➤ #letra [música]
➤ #spotify [nome]

🖼️ *IMAGENS*
➤ #pinterest [busca]

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU ADMIN
    // ===========================================================
    if (sub === 'admin' || sub === 'adm') {
      if (!cargoCheck(groupId, 'admin', 'mod')) {
        return reply(`
╔══════════════════╗
     ⚠️ ACESSO NEGADO ⚠️
╚══════════════════╝

❌ Apenas administradores
   podem ver este menu.

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
        `);
      }

      return reply(`
╔══════════════════╗
     🤖 MENU ADMIN 🤖
╚══════════════════╝

👥 *GERENCIAR MEMBROS*
➤ #ban @user
➤ #add 559999999999
➤ #promover @user
➤ #rebaixar @user
➤ #cargo @user [admin|mod|aux]
➤ #mute @user
➤ #desmute @user

⚠️ *ADVERTÊNCIAS*
➤ #advertir @user [motivo]
➤ #checkwarnings @user
➤ #removewarnings @user
➤ #setlimitec [num]

📢 *MARCAÇÃO*
➤ #marcar [texto]
➤ #tagall [texto]

⚙️ *CONFIGURAÇÕES*
➤ #bemvindo [on/off]
➤ #antilink [on/off]
➤ #antivendas [on/off]
➤ #so_adm [on/off]
➤ #anticall [on/off]
➤ #x9visuunica [on/off]

🔒 *CONTROLE DO GRUPO*
➤ #fechargp
➤ #abrirgp
➤ #banghost
➤ #inativos [dias]

📝 *GRUPO*
➤ #nomegp [nome]
➤ #descgp [desc]
➤ #linkgp
➤ #regras [texto]

🚫 *LISTA NEGRA*
➤ #listanegra add [num]
➤ #listanegra rem [num]
➤ #listanegra ver

🎯 *UTILIDADES*
➤ #sorteio [texto]

⏰ *MENSAGENS AUTOMÁTICAS*
➤ #mensagem-automatica [HH:MM] [texto]
➤ #listar-mensagens-automaticas
➤ #limpar-mensagens-automaticas

🗒️ *NOTAS*
➤ #anotar [texto]
➤ #anotacao
➤ #tirar_nota [num]

🚨 *FILTRO DE PALAVRAS*
➤ #antipalavra [on/off]
➤ #addpalavra [palavra]
➤ #delpalavra [palavra]
➤ #listapalavrao

💤 *STATUS*
➤ #ausente [texto]
➤ #ativo

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU DIVERSÃO
    // ===========================================================
    if (sub === 'diversão' || sub === 'div') {
      return reply(`
╔══════════════════╗
     🎮 MENU DIVERSÃO 🎮
╚══════════════════╝

🎯 *JOGOS*
➤ #ppt [pedra/papel/tesoura]
➤ #dado [lados]
➤ #8ball [pergunta]

💘 *RELACIONAMENTOS*
➤ #casal
➤ #ship @user @user

🏆 *RANKINGS*
➤ #rankgay
➤ #rankgado
➤ #rankcorno

🎲 *BRINCADEIRAS*
➤ #porcentagem [texto]
➤ #chance [texto]
➤ #fakemsg @user [texto]
➤ #bot

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU GRUPO
    // ===========================================================
    if (sub === 'grupo' || sub === 'gp') {
      return reply(`
╔══════════════════╗
     👥 MENU GRUPO 👥
╚══════════════════╝

📊 *ESTATÍSTICAS*
➤ #rankativos
➤ #inativos [dias]
➤ #gpinfo
➤ #admins

📋 *INFORMAÇÕES*
➤ #regras
➤ #linkgp

🎂 *ANIVERSÁRIO*
➤ #aniversario [DD/MM]
➤ #meuaniversario

💤 *AFK*
➤ #ausente [mensagem]
➤ #ativo
➤ #listarafk

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU INFO
    // ===========================================================
    if (sub === 'info' || sub === 'informações') {
      return reply(`
╔══════════════════╗
     ℹ️ MENU INFO ℹ️
╚══════════════════╝

🤖 *SOBRE O BOT*
➤ #info
➤ #ping
➤ #dono

📱 *USUÁRIO*
➤ #perfil [@user]
➤ #sender

📝 *UTILIDADES*
➤ #imc [peso] [altura]
➤ #calculadora [expressão]
➤ #cep [CEP]
➤ #signo [DD/MM]
➤ #clima [cidade]
➤ #horario
➤ #traduzir [idioma] [texto]

💰 *ASSINATURA*
➤ !status
➤ !ativar [dias]
➤ !cancelar

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU GOLD
    // ===========================================================
    if (sub === 'gold' || sub === 'moedas') {
      return reply(`
╔══════════════════╗
     💰 MENU GOLD 💰
╚══════════════════╝

💰 *CONSULTAS*
➤ #gold
➤ #rankgold

🎁 *RECOMPENSAS*
➤ #daily
➤ #minerar_gold

🤝 *TRANSAÇÕES*
➤ #doargold @user [qtd]
➤ #roubargold @user

🎲 *APOSTAS*
➤ #apostar [qtd]
➤ #cassino [qtd]
➤ #doublegold [qtd]

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU TECNOLOGIA
    // ===========================================================
    if (sub === 'tecnologia' || sub === 'tech') {
      return reply(`
╔══════════════════╗
     🖥️ MENU TECNOLOGIA 🖥️
╚══════════════════╝

🌐 *INTERNET*
➤ #testarnet
➤ #velocidade
➤ #meudns
➤ #meuip

🔒 *SEGURANÇA*
➤ #siteseguro [url]
➤ #verificarlink [url]
➤ #senhasegura [senha]
➤ #gerarsenha [tamanho]

📡 *REDES & MODEM*
➤ #resetarmodem
➤ #melhorarsinal
➤ #pingtest [host]
➤ #portacheck [porta]

📱 *DISPOSITIVOS*
➤ #limparcache
➤ #economizarbateria
➤ #liberarmemoria
➤ #modoaviao

🛠️ *DICAS GERAIS*
➤ #dicatech
➤ #atalhos [windows/mac/android]
➤ #formatarpc
➤ #atualizardriver
➤ #vpn
➤ #whoisdominio [domínio]

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU COMANDOS PERSONALIZADOS
    // ===========================================================
    if (sub === 'comandos' || sub === 'cmd') {
      return reply(`
╔══════════════════╗
     📝 COMANDOS PERSONALIZADOS 📝
╚══════════════════╝

📌 *CRIAR COMANDO*
➤ !comando [nome] [texto]
   (pode enviar com imagem!)

📋 *GERENCIAR*
➤ #vercomandos
➤ #delcomando [nome]

💡 *COMO USAR*
1. Envie uma imagem com a legenda:
   !comando saudacao Olá pessoal!
2. Ou sem imagem:
   !comando regra1 Não faça spam
3. Para executar o comando:
   !saudacao  ou  !regra1

⚠️ O texto fica EXATAMENTE como
   você digitou (com formatação).

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // SUBMENU NÃO ENCONTRADO
    // ===========================================================
    return reply(`
╔══════════════════╗
     ❌ SUBMENU INVÁLIDO ❌
╚══════════════════╝

Use #menu para ver
os menus disponíveis:

📌 #menu figurinhas
📌 #menu download
📌 #menu admin
📌 #menu diversão
📌 #menu grupo
📌 #menu info
📌 #menu gold
📌 #menu tecnologia
📌 #menu comandos

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
    `);
  }

  // ===========================================================
  // FIGURINHAS - VERSÃO CORRIGIDA PARA CELULAR
  // ===========================================================

  if (command === '#sticker' || command === '#s') {
    const quoted = getQuoted(message)
    const imageMsg = quoted?.imageMessage || message.message?.imageMessage
    const videoMsg = quoted?.videoMessage || message.message?.videoMessage

    if (!imageMsg && !videoMsg) {
      return reply('❌ Marque uma imagem ou vídeo (máx 10s)')
    }

    await reply('⏳ Criando sua figurinha...')

    try {
      if (imageMsg) {
        const buffer = await downloadMedia(imageMsg, 'image')
        const webpBuffer = await sharp(buffer)
          .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .webp({ quality: 80 })
          .toBuffer()

        await sock.sendMessage(groupId, {
          sticker: webpBuffer,
          packname: 'SignaBot',
          author: senderName
        }, { quoted: message })
        return
      }

      if (videoMsg) {
        if (videoMsg.seconds > 10) {
          return reply('❌ O vídeo deve ter no máximo 10 segundos.')
        }

        const videoBuffer = await downloadMedia(videoMsg, 'video')
        const inputPath = path.join(__dirname, `input_${Date.now()}.mp4`)
        const outputPath = path.join(__dirname, `output_${Date.now()}.webp`)

        fs.writeFileSync(inputPath, videoBuffer)

        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .outputOptions([
              '-vcodec libwebp',
              '-vf scale=512:512:force_original_aspect_ratio=decrease,fps=15',
              '-loop 0',
              '-ss 00:00:00',
              '-t 10',
              '-preset default',
              '-an',
              '-vsync 0'
            ])
            .toFormat('webp')
            .save(outputPath)
            .on('end', resolve)
            .on('error', reject)
        })

        const webpBuffer = fs.readFileSync(outputPath)
        await sock.sendMessage(groupId, {
          sticker: webpBuffer,
          packname: 'SignaBot',
          author: senderName
        }, { quoted: message })

        fs.unlinkSync(inputPath)
        fs.unlinkSync(outputPath)
        return
      }
    } catch (err) {
      console.log('Erro Sticker:', err)
      return reply('❌ Erro ao criar figurinha.')
    }
  }

  // ===========================================================
  // FIGURINHAS - TODOS OS COMANDOS
  // ===========================================================

  // #fig - Atalho para criar figurinha
  if (command === '#fig') {
    const quoted = getQuoted(message)
    const imageMsg = quoted?.imageMessage || message.message?.imageMessage
    const videoMsg = quoted?.videoMessage || message.message?.videoMessage

    if (!imageMsg && !videoMsg) {
      return reply('❌ Marque uma imagem ou vídeo (máx 10s)')
    }

    await reply('⏳ Criando figurinha...')

    try {
      if (imageMsg) {
        const buffer = await downloadMedia(imageMsg, 'image')
        const webpBuffer = await sharp(buffer)
          .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .webp({ quality: 80 })
          .toBuffer()

        await sock.sendMessage(groupId, {
          sticker: webpBuffer,
          packname: 'SignaBot',
          author: senderName
        }, { quoted: message })
        return
      }

      if (videoMsg) {
        if (videoMsg.seconds > 10) {
          return reply('❌ O vídeo deve ter no máximo 10 segundos.')
        }

        const videoBuffer = await downloadMedia(videoMsg, 'video')
        const inputPath = path.join(__dirname, `input_${Date.now()}.mp4`)
        const outputPath = path.join(__dirname, `output_${Date.now()}.webp`)

        fs.writeFileSync(inputPath, videoBuffer)

        await new Promise((resolve, reject) => {
          ffmpeg(inputPath)
            .outputOptions([
              '-vcodec libwebp',
              '-vf scale=512:512:force_original_aspect_ratio=decrease,fps=15',
              '-loop 0',
              '-ss 00:00:00',
              '-t 10',
              '-preset default',
              '-an',
              '-vsync 0'
            ])
            .toFormat('webp')
            .save(outputPath)
            .on('end', resolve)
            .on('error', reject)
        })

        const webpBuffer = fs.readFileSync(outputPath)
        await sock.sendMessage(groupId, {
          sticker: webpBuffer,
          packname: 'SignaBot',
          author: senderName
        }, { quoted: message })

        fs.unlinkSync(inputPath)
        fs.unlinkSync(outputPath)
        return
      }
    } catch (err) {
      console.log('Erro #fig:', err)
      return reply('❌ Erro ao criar figurinha.')
    }
  }

  // #ttp - Texto para figurinha
  if (command === '#ttp') {
    if (args.length === 0) return reply('❌ Use: #ttp [texto]\nExemplo: #ttp Olá Mundo')
    
    const text = args.join(' ')
    await reply('⏳ Criando figurinha de texto...')

    try {
      // Tentar várias APIs
      const apis = [
        `https://api.xteam.xyz/ttp?text=${encodeURIComponent(text)}`,
        `https://api.lolhuman.xyz/api/ttp?apikey=9b817532fadff8fc7cb86862&text=${encodeURIComponent(text)}`,
        `https://api.ashiq.dev/api/ttp?text=${encodeURIComponent(text)}`
      ]

      for (const apiUrl of apis) {
        try {
          const response = await axios.get(apiUrl, {
            responseType: 'arraybuffer',
            timeout: 10000
          })

          if (response.data && response.data.length > 100) {
            await sock.sendMessage(groupId, {
              sticker: Buffer.from(response.data)
            }, { quoted: message })
            return
          }
        } catch (e) {
          console.log(`API TTP falhou: ${apiUrl}`, e.message)
          continue
        }
      }

      return reply('❌ Erro ao criar figurinha de texto. Tente novamente.')

    } catch (err) {
      console.log('Erro #ttp:', err)
      return reply('❌ Erro ao criar figurinha de texto.')
    }
  }

  // #attp - Texto animado para figurinha
  if (command === '#attp') {
    if (args.length === 0) return reply('❌ Use: #attp [texto]\nExemplo: #attp Olá Mundo')
    
    const text = args.join(' ')
    await reply('⏳ Criando figurinha animada...')

    try {
      const response = await axios.get(
        `https://api.xteam.xyz/attp?text=${encodeURIComponent(text)}`,
        { responseType: 'arraybuffer', timeout: 15000 }
      )

      await sock.sendMessage(groupId, {
        sticker: Buffer.from(response.data)
      }, { quoted: message })

    } catch (err) {
      console.log('Erro #attp:', err)
      return reply('❌ Erro ao criar figurinha animada. Tente novamente.')
    }
  }

  // #toimg - Converter figurinha para imagem
  if (command === '#toimg') {
    const quoted = getQuoted(message)
    const stickerMsg = quoted?.stickerMessage || message.message?.stickerMessage

    if (!stickerMsg) {
      return reply('❌ Marque uma figurinha para converter em imagem!')
    }

    await reply('⏳ Convertendo figurinha para imagem...')

    try {
      const buffer = await downloadMedia(stickerMsg, 'sticker')

      if (!buffer) {
        return reply('❌ Erro ao baixar figurinha.')
      }

      // Converter WebP para PNG usando sharp
      const pngBuffer = await sharp(buffer)
        .png()
        .toBuffer()

      await sock.sendMessage(groupId, {
        image: pngBuffer,
        caption: '✅ Imagem convertida com sucesso!'
      }, { quoted: message })

    } catch (err) {
      console.log('Erro #toimg:', err)
      return reply('❌ Erro ao converter figurinha.')
    }
  }

  // #togif - Converter figurinha animada para GIF
  if (command === '#togif') {
    const quoted = getQuoted(message)
    const stickerMsg = quoted?.stickerMessage || message.message?.stickerMessage

    if (!stickerMsg) {
      return reply('❌ Marque uma figurinha animada para converter em GIF!')
    }

    await reply('⏳ Convertendo figurinha para GIF...')

    try {
      const buffer = await downloadMedia(stickerMsg, 'sticker')

      if (!buffer) {
        return reply('❌ Erro ao baixar figurinha.')
      }

      // Salvar WebP temporário
      const inputPath = path.join(__dirname, `sticker_${Date.now()}.webp`)
      const outputPath = path.join(__dirname, `gif_${Date.now()}.gif`)

      fs.writeFileSync(inputPath, buffer)

      // Converter WebP para GIF usando ffmpeg
      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            '-vf fps=15',
            '-loop 0'
          ])
          .toFormat('gif')
          .save(outputPath)
          .on('end', resolve)
          .on('error', reject)
      })

      const gifBuffer = fs.readFileSync(outputPath)

      await sock.sendMessage(groupId, {
        video: gifBuffer,
        gifPlayback: true,
        caption: '✅ GIF convertido com sucesso!'
      }, { quoted: message })

      // Limpeza
      fs.unlinkSync(inputPath)
      fs.unlinkSync(outputPath)

    } catch (err) {
      console.log('Erro #togif:', err)
      return reply('❌ Erro ao converter figurinha para GIF.')
    }
  }

  // #take - Mudar autor/pack da figurinha
  if (command === '#take') {
    const quoted = getQuoted(message)
    const stickerMsg = quoted?.stickerMessage || message.message?.stickerMessage

    if (!stickerMsg) {
      return reply('❌ Marque uma figurinha para editar!')
    }

    const author = args[0] || 'SignaBot'
    const pack = args[1] || 'Stickers'

    await reply(`⏳ Alterando figurinha...\nAutor: ${author}\nPack: ${pack}`)

    try {
      const buffer = await downloadMedia(stickerMsg, 'sticker')

      if (!buffer) {
        return reply('❌ Erro ao baixar figurinha.')
      }

      await sock.sendMessage(groupId, {
        sticker: buffer,
        packname: pack,
        author: author
      }, { quoted: message })

    } catch (err) {
      console.log('Erro #take:', err)
      return reply('❌ Erro ao editar figurinha.')
    }
  }

  // ===========================================================
  // DOWNLOADS
  // ===========================================================

  if (command === '#play' || command === '#ytmp3') {
    if (args.length === 0) return reply('Use: #play [nome ou URL da musica]');
    const query = args.join(' ');
    await reply('Buscando: ' + query + '...');
    try {
      const results = await yts(query);
      const video = results.videos[0];
      if (!video) return reply('Nenhum resultado encontrado.');

      await reply(`Encontrado: *${video.title}*\nDuracao: ${video.timestamp}\nBaixando audio...`);

      // APIs de fallback para áudio
      const ytAudioApis = [
        async () => {
          const { data } = await axios.get(`https://api.xteam.xyz/ytdl?url=${encodeURIComponent(video.url)}&type=audio`, { timeout: 30000 });
          return data?.url || null;
        },
        async () => {
          const { data } = await axios.get(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(video.url)}`, { timeout: 30000 });
          return data?.data?.url || data?.url || null;
        },
        async () => {
          const { data } = await axios.get(`https://api.ryzendesu.vip/api/downloader/ytmp3?url=${encodeURIComponent(video.url)}`, { timeout: 30000 });
          return data?.url || data?.data?.url || null;
        },
      ];

      let audioUrl = null;
      for (const apiFn of ytAudioApis) {
        try { audioUrl = await apiFn(); if (audioUrl) break; } catch {}
      }
      if (!audioUrl) return reply('Nao foi possivel obter o audio. Tente novamente mais tarde.');

      const audioResp = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 60000 });
      const buffer = Buffer.from(audioResp.data);

      await sock.sendMessage(groupId, {
        audio: buffer,
        mimetype: 'audio/mpeg',
        ptt: false,
      }, { quoted: message });

      await sock.sendMessage(groupId, {
        image: { url: video.thumbnail },
        caption: `*${video.title}*\nDuracao: ${video.timestamp}\nViews: ${video.views}`,
      });
    } catch (err) { return reply('Erro ao baixar audio: ' + err.message); }
    return;
  }

  if (command === '#playvideo' || command === '#ytmp4') {
    if (args.length === 0) return reply('Use: #playvideo [nome ou URL]');
    const query = args.join(' ');
    await reply('Buscando: ' + query + '...');
    try {
      const results = await yts(query);
      const video = results.videos[0];
      if (!video) return reply('Nenhum resultado encontrado.');

      if (video.seconds > 600) return reply('Video muito longo (max 10 minutos).');

      await reply(`Encontrado: *${video.title}*\nDuracao: ${video.timestamp}\nBaixando video...`);

      // APIs de fallback para vídeo
      const ytVideoApis = [
        async () => {
          const { data } = await axios.get(`https://api.xteam.xyz/ytdl?url=${encodeURIComponent(video.url)}&type=video`, { timeout: 30000 });
          return data?.url || null;
        },
        async () => {
          const { data } = await axios.get(`https://api.siputzx.my.id/api/d/ytmp4?url=${encodeURIComponent(video.url)}`, { timeout: 30000 });
          return data?.data?.url || data?.url || null;
        },
        async () => {
          const { data } = await axios.get(`https://api.ryzendesu.vip/api/downloader/ytmp4?url=${encodeURIComponent(video.url)}`, { timeout: 30000 });
          return data?.url || data?.data?.url || null;
        },
      ];

      let videoUrl = null;
      for (const apiFn of ytVideoApis) {
        try { videoUrl = await apiFn(); if (videoUrl) break; } catch {}
      }
      if (!videoUrl) return reply('Nao foi possivel obter o video. Tente novamente mais tarde.');

      const videoResp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
      const buffer = Buffer.from(videoResp.data);

      await sock.sendMessage(groupId, {
        video: buffer,
        caption: `*${video.title}*\nDuracao: ${video.timestamp}`,
      }, { quoted: message });
    } catch (err) { return reply('Erro ao baixar video: ' + err.message); }
    return;
  }

  if (command === '#ytsearch') {
    if (args.length === 0) return reply('Use: #ytsearch [busca]');
    try {
      const results = await yts(args.join(' '));
      const videos = results.videos.slice(0, 5);
      if (!videos.length) return reply('Nenhum resultado.');
      let text = '*Resultados no YouTube:*\n\n';
      videos.forEach((v, i) => {
        text += `${i + 1}. *${v.title}*\nDuracao: ${v.timestamp}\nURL: ${v.url}\n\n`;
      });
      return reply(text);
    } catch { return reply('Erro na busca.'); }
  }

 // #tiktok - Baixar vídeo do TikTok (COM MÚLTIPLAS APIS DE FALLBACK)
if (command === '#tiktok' || command === '#tt') {
  if (args.length === 0) return reply('❌ Use: #tiktok [URL do vídeo]\nExemplo: #tiktok https://tiktok.com/@user/video/123456');
  
  const url = args[0];
  
  // Validar URL do TikTok
  if (!url.includes('tiktok.com')) {
    return reply('❌ URL inválida! Certifique-se de enviar um link do TikTok.');
  }

  await reply('⏳ *Baixando vídeo do TikTok...*\n\nIsso pode levar alguns segundos.');

  // Lista de APIs para tentar (em ordem de confiabilidade)
  const apis = [
    {
      name: 'API TikDown',
      url: `https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`,
      getVideo: (data) => data?.video?.noWatermark || data?.video?.no_wm || data?.video?.[0]
    },
    {
      name: 'API TikWM',
      url: `https://api.tikwm.com/api/?url=${encodeURIComponent(url)}`,
      getVideo: (data) => data?.data?.play || data?.data?.wmplay
    },
    {
      name: 'API TikDown2',
      url: `https://api.tikdown.xyz/api/download?url=${encodeURIComponent(url)}`,
      getVideo: (data) => data?.result?.video?.no_watermark
    },
    {
      name: 'API TikMate',
      url: `https://api.tikmate.cc/api?url=${encodeURIComponent(url)}`,
      getVideo: (data) => data?.video_url
    },
    {
      name: 'API SSSTik',
      url: `https://api.ssstik.io/video?url=${encodeURIComponent(url)}`,
      getVideo: (data) => data?.video
    }
  ];

  // Tentar cada API
  for (const api of apis) {
    try {
      console.log(`[TIKTOK] Tentando API: ${api.name}`);
      
      const response = await axios.get(api.url, { 
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      const data = response.data;
      const videoUrl = api.getVideo(data);

      if (videoUrl) {
        console.log(`[TIKTOK] ✅ API ${api.name} funcionou!`);

        // Baixar o vídeo
        const videoResp = await axios.get(videoUrl, { 
          responseType: 'arraybuffer', 
          timeout: 60000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        const buffer = Buffer.from(videoResp.data);

        // Obter informações do vídeo
        const author = data?.author?.nickname || data?.data?.author?.nickname || 'TikTok User';
        const caption = data?.caption || data?.data?.title || 'Vídeo do TikTok';
        const views = data?.play_count || data?.data?.play_count || '0';

        // Enviar o vídeo
        await sock.sendMessage(groupId, {
          video: buffer,
          caption: `📱 *TikTok*\n\n👤 *Autor:* ${author}\n📝 *Descrição:* ${caption}\n👁️ *Views:* ${views}\n\n✅ Download realizado com sucesso!`,
          mentions: [sender]
        }, { quoted: message });

        return; // Sai da função se funcionou
      }
    } catch (err) {
      console.log(`[TIKTOK] ❌ API ${api.name} falhou:`, err.message);
      continue; // Tenta a próxima API
    }
  }

  // Se todas as APIs falharem, tenta um método alternativo
  try {
    console.log('[TIKTOK] Tentando método alternativo...');
    
    // Extrair ID do vídeo da URL
    const videoId = url.match(/\d{15,}/)?.[0] || url.match(/video\/(\d+)/)?.[1];
    
    if (videoId) {
      // Usar API alternativa
      const altUrl = `https://tiktok-video-no-watermark-download.p.rapidapi.com/tiktok?url=https://www.tiktok.com/@user/video/${videoId}`;
      
      const response = await axios.get(altUrl, {
        timeout: 15000,
        headers: {
          'X-RapidAPI-Key': 'sua-chave-aqui', // Você precisaria de uma chave
          'X-RapidAPI-Host': 'tiktok-video-no-watermark-download.p.rapidapi.com'
        }
      });

      if (response.data?.videoUrl) {
        const videoResp = await axios.get(response.data.videoUrl, {
          responseType: 'arraybuffer',
          timeout: 60000
        });

        const buffer = Buffer.from(videoResp.data);

        await sock.sendMessage(groupId, {
          video: buffer,
          caption: '📱 *TikTok*\n\n✅ Download realizado com sucesso!'
        }, { quoted: message });

        return;
      }
    }
  } catch (err) {
    console.log('[TIKTOK] ❌ Método alternativo falhou:', err.message);
  }

  // Se tudo falhar, mostrar instruções
  return reply(`❌ *Erro ao baixar TikTok*\n\nNão foi possível baixar o vídeo no momento. As APIs estão instáveis.\n\n💡 *Sugestões:*\n1️⃣ Tente novamente mais tarde\n2️⃣ Use o comando #instagram para vídeos do Instagram\n3️⃣ Use #play para músicas do YouTube\n\n📱 *Link:* ${url}`);
}

  if (command === '#instagram' || command === '#insta') {
    if (args.length === 0) return reply('Use: #instagram [URL]');
    const url = args[0];
    if (!url.includes('instagram.com')) return reply('❌ URL invalida. Envie um link do Instagram.');
    await reply('⏳ Baixando do Instagram...');

    // Lista de APIs para tentar
    const instaApis = [
      {
        name: 'xteam',
        fetch: async () => {
          const { data } = await axios.get(`https://api.xteam.xyz/igdl?url=${encodeURIComponent(url)}`, { timeout: 20000 });
          if (!data?.url) return null;
          return { mediaUrl: data.url, isVideo: data.type === 'video' };
        }
      },
      {
        name: 'siputzx',
        fetch: async () => {
          const { data } = await axios.get(`https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(url)}`, { timeout: 20000 });
          const link = data?.data?.[0]?.url || data?.url;
          if (!link) return null;
          const isVideo = link.includes('.mp4') || data?.data?.[0]?.type === 'video';
          return { mediaUrl: link, isVideo };
        }
      },
      {
        name: 'ryzendesu',
        fetch: async () => {
          const { data } = await axios.get(`https://api.ryzendesu.vip/api/downloader/igdl?url=${encodeURIComponent(url)}`, { timeout: 20000 });
          const link = data?.data?.[0]?.url || data?.url;
          if (!link) return null;
          return { mediaUrl: link, isVideo: link.includes('.mp4') };
        }
      },
      {
        name: 'tikwm-ig',
        fetch: async () => {
          const { data } = await axios.get(`https://api.tikwm.com/api/?url=${encodeURIComponent(url)}`, { timeout: 20000 });
          const link = data?.data?.play || data?.data?.wmplay;
          if (!link) return null;
          return { mediaUrl: link, isVideo: true };
        }
      },
    ];

    for (const api of instaApis) {
      try {
        console.log(`[INSTAGRAM] Tentando API: ${api.name}`);
        const result = await api.fetch();
        if (!result?.mediaUrl) continue;

        const mediaResp = await axios.get(result.mediaUrl, {
          responseType: 'arraybuffer',
          timeout: 60000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const buffer = Buffer.from(mediaResp.data);

        if (result.isVideo) {
          await sock.sendMessage(groupId, { video: buffer, caption: '📸 Instagram' }, { quoted: message });
        } else {
          await sock.sendMessage(groupId, { image: buffer, caption: '📸 Instagram' }, { quoted: message });
        }
        console.log(`[INSTAGRAM] ✅ API ${api.name} funcionou!`);
        return;
      } catch (err) {
        console.log(`[INSTAGRAM] ❌ API ${api.name} falhou:`, err.message);
      }
    }

    return reply('❌ Nao foi possivel baixar o conteudo do Instagram.\n\nVerifique se:\n• O link e valido\n• O perfil e publico\n• Tente novamente mais tarde');
  }

  if (command === '#pinterest') {
    if (args.length === 0) return reply('Use: #pinterest [busca]');
    const query = args.join(' ');
    try {
      const { data } = await axios.get(
        `https://api.xteam.xyz/pinterest?search=${encodeURIComponent(query)}`,
        { timeout: 15000 }
      );
      if (!data?.result?.length) return reply('Nenhuma imagem encontrada.');
      const img = data.result[Math.floor(Math.random() * Math.min(data.result.length, 5))];
      await sock.sendMessage(groupId, { image: { url: img }, caption: `Pinterest: ${query}` }, { quoted: message });
    } catch { return reply('Erro ao buscar no Pinterest.'); }
    return;
  }

  if (command === '#letra') {
    if (args.length === 0) return reply('Use: #letra [nome da musica]');
    const query = args.join(' ');
    try {
      const { data } = await axios.get(
        `https://api.vagalume.com.br/search.php?q=${encodeURIComponent(query)}&apikey=09f9e8f8`,
        { timeout: 10000 }
      );
      if (data.type === 'notfound') return reply('Letra nao encontrada.');
      const music = data.response?.docs?.[0];
      if (!music) return reply('Letra nao encontrada.');
      const letra = music.text.substring(0, 1500);
      return reply(`*${music.band.name} - ${music.name}*\n\n${letra}${music.text.length > 1500 ? '\n\n[Continua...]' : ''}`);
    } catch { return reply('Erro ao buscar letra.'); }
  }

  if (command === '#spotify') {
    if (args.length === 0) return reply('Use: #spotify [nome da musica]');
    const query = args.join(' ');
    try {
      const { data } = await axios.get(
        `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&limit=1`,
        { timeout: 10000 }
      );
      const song = data?.data?.results?.[0];
      if (!song) return reply('Musica nao encontrada.');
      return reply(`*${song.name}*\nArtista: ${song.artists?.primary?.map(a => a.name).join(', ') || '-'}\nAlbum: ${song.album?.name || '-'}\nDuracao: ${Math.floor(song.duration / 60)}:${String(song.duration % 60).padStart(2, '0')}`);
    } catch { return reply('Erro ao buscar no Spotify.'); }
  }

  if (command === '#autobaixar') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    if (args[0] === 'on') { settings.autoBaixar = true; saveSettings(); return reply('Auto-baixar ativado! Links de YouTube, TikTok e Instagram serao baixados automaticamente.'); }
    if (args[0] === 'off') { settings.autoBaixar = false; saveSettings(); return reply('Auto-baixar desativado.'); }
    return reply(`Auto-baixar: ${settings.autoBaixar ? 'Ativado' : 'Desativado'}\nUse: #autobaixar [on/off]`);
  }

  // ===========================================================
  // ADMINISTRACAO
  // ===========================================================

  if (command === '#ban') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    
    // Verificar se está respondendo (reply) a uma mensagem
    const quotedParticipant = getQuotedSender(message);
    const mentioned = getMentioned(message);
    
    // Prioridade: quem foi mencionado na mensagem respondida (reply)
    let targetUser = null;
    if (quotedParticipant) {
      targetUser = quotedParticipant;
    } else if (mentioned.length) {
      targetUser = mentioned[0];
    }
    
    if (!targetUser) return reply('❌ Mencione (reply) a mensagem do usuário que deseja banir!');
    
    try {
      // Deletar a mensagem do usuário banido (a mensagem que foi respondida)
      const quotedKey = message.message?.extendedTextMessage?.contextInfo;
      if (quotedKey?.stanzaId) {
        await sock.sendMessage(groupId, { delete: {
          remoteJid: groupId,
          fromMe: false,
          id: quotedKey.stanzaId,
          participant: quotedKey.participant,
        }}).catch(() => {});
      }
      
      // Remover o usuário do grupo
      await sock.groupParticipantsUpdate(groupId, [targetUser], 'remove');
      return reply(`✅ Usuário @${targetUser.split('@')[0]} banido com sucesso!`);
    } catch (err) { return reply('❌ Erro ao banir: ' + err.message); }
  }

  if (command === '#add') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    if (!args[0]) return reply('Use: #add [numero com DDI]\nEx: #add 5592999999999');
    const num = args[0].replace(/\D/g, '') + '@s.whatsapp.net';
    try {
      await sock.groupParticipantsUpdate(groupId, [num], 'add');
      return reply('Membro adicionado!');
    } catch (err) { return reply('Erro ao adicionar: ' + err.message); }
  }

  if (command === '#promover') {
    if (!cargoCheck(groupId, 'admin')) return reply('Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('Marque o usuario!');
    try {
      await sock.groupParticipantsUpdate(groupId, [mentioned[0]], 'promote');
      return reply('Usuario promovido a admin!');
    } catch (err) { return reply('Erro: ' + err.message); }
  }

  if (command === '#rebaixar') {
    if (!cargoCheck(groupId, 'admin')) return reply('Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('Marque o usuario!');
    try {
      await sock.groupParticipantsUpdate(groupId, [mentioned[0]], 'demote');
      return reply('Admin rebaixado!');
    } catch (err) { return reply('Erro: ' + err.message); }
  }

  if (command === '#cargo') {
    if (!cargoCheck(groupId, 'admin')) return reply('Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length || !args[1]) return reply('Use: #cargo @usuario [admin|mod|aux|remover]');
    const userId = mentioned[0];
    const novoCargo = args[1].toLowerCase();
    if (!['admin', 'mod', 'aux', 'remover'].includes(novoCargo)) return reply('Cargos validos: admin, mod, aux, remover');
    if (!cargos[groupId]) cargos[groupId] = {};
    if (novoCargo === 'remover') { delete cargos[groupId][userId]; }
    else { cargos[groupId][userId] = novoCargo; }
    saveDB('cargos', cargos);
    return reply(novoCargo === 'remover' ? 'Cargo removido!' : `Cargo "${novoCargo}" atribuido com sucesso!`);
  }

  if (command === '#advertir') {
    if (!cargoCheck(groupId, 'admin', 'mod', 'aux')) return reply('Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('Marque o usuario para advertir!');
    const userId = mentioned[0];
    const motivo = args.slice(1).join(' ') || 'Sem motivo';
    if (!warnings[groupId]) warnings[groupId] = {};
    if (!warnings[groupId][userId]) warnings[groupId][userId] = [];
    warnings[groupId][userId].push({ date: Date.now(), motivo });
    saveDB('warnings', warnings);
    const count = warnings[groupId][userId].length;
    const limit = settings.warningLimit || 3;
    if (count >= limit) {
      try {
        // Adicionar na lista negra automaticamente
        if (!blacklist[userId]) blacklist[userId] = { date: Date.now(), reason: 'Atingiu limite de advertencias' };
        saveDB('blacklist', blacklist);
        await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
        delete warnings[groupId][userId];
        saveDB('warnings', warnings);
        return sock.sendMessage(groupId, {
          text: `Usuario banido por atingir ${limit} advertencias!\nMotivo: ${motivo}`,
          mentions: [userId],
        });
      } catch (err) { return reply('Erro ao banir apos advertencias: ' + err.message); }
    }
    return sock.sendMessage(groupId, {
      text: `Advertencia ${count}/${limit} aplicada!\nMotivo: ${motivo}`,
      mentions: [userId],
    });
  }

  if (command === '#checkwarnings' || command === '#ver_adv') {
    const mentioned = getMentioned(message);
    const userId = mentioned.length ? mentioned[0] : sender;
    const userWarns = warnings[groupId]?.[userId];
    if (!userWarns || !userWarns.length) return reply('Sem advertencias.');
    const limit = settings.warningLimit || 3;
    let text = `Advertencias: ${userWarns.length}/${limit}\n\n`;
    userWarns.forEach((w, i) => {
      text += `${i + 1}. ${new Date(w.date).toLocaleString('pt-BR')}\nMotivo: ${w.motivo}\n\n`;
    });
    return reply(text);
  }

  if (command === '#removewarnings' || command === '#rm_adv') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('Marque o usuario!');
    const userId = mentioned[0];
    if (warnings[groupId]) delete warnings[groupId][userId];
    saveDB('warnings', warnings);
    return reply('Advertencias removidas!');
  }

  if (command === '#setlimitec') {
    if (!cargoCheck(groupId, 'admin')) return reply('Sem permissao.');
    const num = parseInt(args[0]);
    if (isNaN(num) || num < 1) return reply('Use: #setlimitec [numero]\nEx: #setlimitec 3');
    settings.warningLimit = num;
    saveSettings();
    return reply(`Limite de advertencias definido para ${num}.`);
  }

  if (command === '#advertidos') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    const grpWarns = warnings[groupId];
    if (!grpWarns || !Object.keys(grpWarns).length) return reply('Nenhum usuario advertido.');
    let text = 'Usuarios com advertencias:\n\n';
    const mentions = [];
    Object.entries(grpWarns).forEach(([uid, warns]) => {
      if (warns.length > 0) { text += `@${uid.split('@')[0]}: ${warns.length} adv.\n`; mentions.push(uid); }
    });
    return sock.sendMessage(groupId, { text, mentions });
  }

  if (command === '#marcar' || command === '#tagall' || command === '#totag') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    try {
      const meta = await sock.groupMetadata(groupId);
      const participants = meta.participants.map(p => p.id);
      const text = args.join(' ') || 'Marcacao geral!';
      await sock.sendMessage(groupId, { text: `*Marcacao Geral*\n\n${text}`, mentions: participants });
    } catch (err) { return reply('Erro: ' + err.message); }
    return;
  }

  if (command === '#deletar' || command === '#del') {
    if (!cargoCheck(groupId, 'admin', 'mod', 'aux')) return reply('Sem permissao.');
    const quoted = getQuoted(message);
    if (!quoted) return reply('Marque a mensagem para deletar!');
    const quotedKey = message.message?.extendedTextMessage?.contextInfo;
    if (!quotedKey) return reply('Nao foi possivel identificar a mensagem.');
    try {
      await sock.sendMessage(groupId, { delete: {
        remoteJid: groupId,
        fromMe: false,
        id: quotedKey.stanzaId,
        participant: quotedKey.participant,
      }});
    } catch { return reply('Nao consegui apagar a mensagem (preciso ser admin).'); }
    return;
  }

  if (command === '#fechargp' || command === '#colloportus') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    try {
      await sock.groupSettingUpdate(groupId, 'announcement');
      return reply('Grupo fechado! Apenas admins podem enviar mensagens.');
    } catch (err) { return reply('Erro: ' + err.message); }
  }

  if (command === '#abrirgp' || command === '#alohomora') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    try {
      await sock.groupSettingUpdate(groupId, 'not_announcement');
      return reply('Grupo aberto! Todos podem enviar mensagens.');
    } catch (err) { return reply('Erro: ' + err.message); }
  }

  if (command === '#linkgp') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    try {
      const code = await sock.groupInviteCode(groupId);
      return reply(`Link do grupo:\nhttps://chat.whatsapp.com/${code}`);
    } catch (err) { return reply('Erro: ' + err.message); }
  }

  if (command === '#nomegp') {
    if (!cargoCheck(groupId, 'admin')) return reply('Sem permissao.');
    if (!args.length) return reply('Use: #nomegp [novo nome]');
    try {
      await sock.groupUpdateSubject(groupId, args.join(' '));
      return reply('Nome do grupo alterado!');
    } catch (err) { return reply('Erro: ' + err.message); }
  }

  if (command === '#descgp') {
    if (!cargoCheck(groupId, 'admin')) return reply('Sem permissao.');
    if (!args.length) return reply('Use: #descgp [nova descricao]');
    try {
      await sock.groupUpdateDescription(groupId, args.join(' '));
      return reply('Descricao do grupo alterada!');
    } catch (err) { return reply('Erro: ' + err.message); }
  }

  if (command === '#regras') {
    if (!args.length) {
      const r = rules[groupId];
      return reply(r ? `*Regras do grupo:*\n\n${r}` : 'Nenhuma regra definida.');
    }
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    rules[groupId] = args.join(' ');
    saveDB('rules', rules);
    return reply('Regras definidas!');
  }

  if (command === '#gpinfo' || command === '#grupoinfo') {
    try {
      const meta = await sock.groupMetadata(groupId);
      const admins = meta.participants.filter(p => p.admin).length;
      return reply(`*Informacoes do Grupo*\n\nNome: ${meta.subject}\nDescricao: ${meta.desc || '-'}\nCriado: ${new Date(meta.creation * 1000).toLocaleString('pt-BR')}\nMembros: ${meta.participants.length}\nAdmins: ${admins}`);
    } catch (err) { return reply('Erro: ' + err.message); }
  }

  if (command === '#admins') {
    try {
      const meta = await sock.groupMetadata(groupId);
      const admins = meta.participants.filter(p => p.admin);
      let text = '*Admins do grupo:*\n\n';
      admins.forEach(a => { text += `@${a.id.split('@')[0]}\n`; });
      return sock.sendMessage(groupId, { text, mentions: admins.map(a => a.id) });
    } catch { return reply('Erro ao buscar admins.'); }
  }

  if (command === '#so_adm') {
    if (!cargoCheck(groupId, 'admin')) return reply('Sem permissao.');
    if (args[0] === 'on') { settings.soAdm = true; saveSettings(); return reply('Modo so-admins ativado!'); }
    if (args[0] === 'off') { settings.soAdm = false; saveSettings(); return reply('Modo so-admins desativado.'); }
    return reply(`Modo so-admins: ${settings.soAdm ? 'Ativado' : 'Desativado'}\nUse: #so_adm [on/off]`);
  }

  if (command === '#bemvindo') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    if (args[0] === 'on') { settings.welcome = true; saveSettings(); return reply('Boas-vindas ativadas!'); }
    if (args[0] === 'off') { settings.welcome = false; saveSettings(); return reply('Boas-vindas desativadas.'); }
    return reply(`Boas-vindas: ${settings.welcome ? 'Ativado' : 'Desativado'}\nUse: #bemvindo [on/off]`);
  }

  if (command === '#antilink') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    if (args[0] === 'on') { settings.antilink = true; saveSettings(); return reply('Antilink ativado! Apenas Instagram, YouTube e TikTok permitidos.'); }
    if (args[0] === 'off') { settings.antilink = false; saveSettings(); return reply('Antilink desativado.'); }
    return reply(`Antilink: ${settings.antilink ? 'Ativado' : 'Desativado'}\nUse: #antilink [on/off]`);
  }

  if (command === '#antipalavra') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    if (args[0] === 'on') { settings.antiPalavra = true; saveSettings(); return reply('Filtro de palavroes ativado!'); }
    if (args[0] === 'off') { settings.antiPalavra = false; saveSettings(); return reply('Filtro de palavroes desativado.'); }
    return reply(`Filtro de palavroes: ${settings.antiPalavra ? 'Ativado' : 'Desativado'}\nUse: #antipalavra [on/off]`);
  }

  if (command === '#addpalavra') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    if (!args.length) return reply('Use: #addpalavra [palavra]');
    const word = args[0].toLowerCase();
    if (!settings.palavroes) settings.palavroes = [];
    if (!settings.palavroes.includes(word)) { settings.palavroes.push(word); saveSettings(); return reply(`Palavra "${word}" adicionada ao filtro.`); }
    return reply('Palavra ja esta no filtro.');
  }

  if (command === '#delpalavra') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    if (!args.length) return reply('Use: #delpalavra [palavra]');
    const word = args[0].toLowerCase();
    settings.palavroes = (settings.palavroes || []).filter(p => p !== word);
    saveSettings();
    return reply(`Palavra "${word}" removida do filtro.`);
  }

  if (command === '#listapalavrao') {
    if (!settings.palavroes || !settings.palavroes.length) return reply('Nenhum palavrao no filtro.');
    return reply(`Palavroes no filtro:\n\n${settings.palavroes.join(', ')}`);
  }

  if (command === '#antivendas') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    if (args[0] === 'on') { settings.antiVendas = true; saveSettings(); return reply('🚫 Anti vendas ativado! Mensagens de venda serão deletadas e os admins serão notificados.'); }
    if (args[0] === 'off') { settings.antiVendas = false; saveSettings(); return reply('✅ Anti vendas desativado.'); }
    return reply(`🚫 Anti vendas: ${settings.antiVendas ? 'Ativado' : 'Desativado'}\nUse: #antivendas [on/off]`);
  }

  if (command === '#anticall') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    if (args[0] === 'on') { settings.anticall = true; saveSettings(); return reply('Anti-chamada ativado!'); }
    if (args[0] === 'off') { settings.anticall = false; saveSettings(); return reply('Anti-chamada desativado.'); }
    return reply(`Anti-chamada: ${settings.anticall ? 'Ativado' : 'Desativado'}\nUse: #anticall [on/off]`);
  }

  if (command === '#x9visuunica') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    if (args[0] === 'on') { settings.antiViewOnce = true; saveSettings(); return reply('Revelador de view-once ativado!'); }
    if (args[0] === 'off') { settings.antiViewOnce = false; saveSettings(); return reply('Revelador de view-once desativado.'); }
    return reply(`View-once revelar: ${settings.antiViewOnce ? 'Ativado' : 'Desativado'}\nUse: #x9visuunica [on/off]`);
  }

  if (command === '#mute') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('Marque o usuario!');
    const userId = mentioned[0];
    if (!muted[groupId]) muted[groupId] = [];
    if (!muted[groupId].includes(userId)) { muted[groupId].push(userId); saveDB('muted', muted); }
    return sock.sendMessage(groupId, { text: `Usuario mutado! Mensagens dele serao apagadas.`, mentions: [userId] });
  }

  if (command === '#desmute') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('Marque o usuario!');
    const userId = mentioned[0];
    if (muted[groupId]) { muted[groupId] = muted[groupId].filter(u => u !== userId); saveDB('muted', muted); }
    return sock.sendMessage(groupId, { text: `Usuario desmutado!`, mentions: [userId] });
  }

  // LISTA NEGRA
  if (command === '#listanegra') {
    const sub = args[0]?.toLowerCase();
    if (sub === 'add') {
      if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
      const num = args[1]?.replace(/\D/g, '');
      if (!num) return reply('Use: #listanegra add [numero]');
      blacklist[num + '@s.whatsapp.net'] = { date: Date.now(), reason: args.slice(2).join(' ') || 'Banido' };
      saveDB('blacklist', blacklist);
      return reply(`Numero ${num} adicionado a lista negra.`);
    }
    if (sub === 'rem') {
      if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
      const num = args[1]?.replace(/\D/g, '');
      if (!num) return reply('Use: #listanegra rem [numero]');
      delete blacklist[num + '@s.whatsapp.net'];
      saveDB('blacklist', blacklist);
      return reply(`Numero ${num} removido da lista negra.`);
    }
    if (sub === 'ver') {
      const entries = Object.entries(blacklist);
      if (!entries.length) return reply('Lista negra vazia.');
      let text = '*Lista Negra:*\n\n';
      entries.slice(0, 30).forEach(([jid, info]) => {
        text += `+${jid.split('@')[0]} — ${info.reason}\n`;
      });
      return reply(text);
    }
    return reply('Use: #listanegra [add|rem|ver] [numero]');
  }

  // ANOTACOES
  if (command === '#anotar') {
    if (!cargoCheck(groupId, 'admin', 'mod', 'aux')) return reply('Sem permissao.');
    if (!args.length) return reply('Use: #anotar [texto]');
    if (!notes[groupId]) notes[groupId] = [];
    notes[groupId].push({ text: args.join(' '), date: Date.now(), by: sender });
    saveDB('notes', notes);
    return reply(`Nota ${notes[groupId].length} salva!`);
  }

  if (command === '#anotacao' || command === '#anotacoes') {
    const grpNotes = notes[groupId];
    if (!grpNotes || !grpNotes.length) return reply('Nenhuma anotacao salva.');
    let text = '*Anotacoes:*\n\n';
    grpNotes.forEach((n, i) => { text += `${i + 1}. ${n.text}\n   (${new Date(n.date).toLocaleString('pt-BR')})\n\n`; });
    return reply(text);
  }

  if (command === '#tirar_nota' || command === '#rmnota') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    const idx = parseInt(args[0]) - 1;
    if (!notes[groupId] || isNaN(idx) || !notes[groupId][idx]) return reply('Numero de nota invalido.');
    notes[groupId].splice(idx, 1);
    saveDB('notes', notes);
    return reply('Nota removida!');
  }

  // SORTEIO - CORRIGIDO
if (command === '#sorteio') {
  try {
    const meta = await sock.groupMetadata(groupId);
    // Primeiro obtém o ID do bot
    const botId = sock.user?.id;
    // Depois faz o filtro sem usar await
    const members = botId 
      ? meta.participants.filter(p => p.id !== botId)
      : meta.participants;
    
    if (!members.length) return reply('Nenhum membro para sortear.');
    const winner = members[Math.floor(Math.random() * members.length)];
    return sock.sendMessage(groupId, {
      text: `*Resultado do Sorteio!*\n\nParabens ao sortudo(a):\n@${winner.id.split('@')[0]}!\n\n${args.join(' ')}`,
      mentions: [winner.id],
    });
  } catch (err) { 
    console.log('[ERRO SORTEIO]', err);
    return reply('Erro ao realizar sorteio.'); 
  }
}

  // MENSAGENS AGENDADAS
  if (command === '#mensagem-automatica') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    if (args.length < 2) return reply('Use: #mensagem-automatica [HH:MM] [texto]\nEx: #mensagem-automatica 08:00 Bom dia!');
    const time = args[0];
    const text = args.slice(1).join(' ');
    if (!/^\d{2}:\d{2}$/.test(time)) return reply('Formato de hora invalido. Use HH:MM\nEx: 08:00');
    if (!autoMessages[groupId]) autoMessages[groupId] = [];
    autoMessages[groupId].push({ time, text, id: Date.now() });
    saveDB('autoMessages', autoMessages);
    return reply(`Mensagem automatica agendada para ${time}:\n"${text}"`);
  }

  if (command === '#listar-mensagens-automaticas') {
    const msgs = autoMessages[groupId];
    if (!msgs || !msgs.length) return reply('Nenhuma mensagem automatica agendada.');
    let text = '*Mensagens Automaticas:*\n\n';
    msgs.forEach((m, i) => { text += `${i + 1}. [${m.time}] ${m.text}\n`; });
    return reply(text);
  }

  if (command === '#limpar-mensagens-automaticas') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    autoMessages[groupId] = [];
    saveDB('autoMessages', autoMessages);
    return reply('Mensagens automaticas removidas!');
  }

  // HORARIO ABERTURA/FECHAMENTO
  if (command === '#opengp') {
    if (!cargoCheck(groupId, 'admin')) return reply('Sem permissao.');
    if (!args[0]) return reply('Use: #opengp [HH:MM]\nEx: #opengp 08:00');
    settings.openAt = args[0];
    saveSettings();
    return reply(`Grupo vai abrir automaticamente as ${args[0]}`);
  }

  if (command === '#closegp') {
    if (!cargoCheck(groupId, 'admin')) return reply('Sem permissao.');
    if (!args[0]) return reply('Use: #closegp [HH:MM]\nEx: #closegp 22:00');
    settings.closeAt = args[0];
    saveSettings();
    return reply(`Grupo vai fechar automaticamente as ${args[0]}`);
  }

  if (command === '#rm_opengp') {
    if (!cargoCheck(groupId, 'admin')) return reply('Sem permissao.');
    settings.openAt = null;
    settings.closeAt = null;
    saveSettings();
    return reply('Horarios de abertura/fechamento removidos.');
  }

  // AFK - AUSENTE
  if (command === '#ausente') {
    const msg = args.join(' ') || 'Estou ausente no momento.';
    afkList[sender] = { msg, time: Date.now(), groupId };
    saveDB('afkList', afkList);
    return sock.sendMessage(groupId, { text: `@${sender.split('@')[0]} entrou no modo ausente.\nMensagem: ${msg}`, mentions: [sender] });
  }

  if (command === '#ativo') {
    if (afkList[sender]) {
      const afk = afkList[sender];
      const duration = formatTime(Date.now() - afk.time);
      delete afkList[sender];
      saveDB('afkList', afkList);
      return sock.sendMessage(groupId, { text: `@${sender.split('@')[0]} voltou!\nFicou ausente por: ${duration}`, mentions: [sender] });
    }
    return reply('Voce nao esta ausente.');
  }

  if (command === '#listarafk') {
    const entries = Object.entries(afkList).filter(([, v]) => v.groupId === groupId);
    if (!entries.length) return reply('Nenhum membro ausente.');
    let text = '*Membros Ausentes:*\n\n';
    entries.forEach(([uid, info]) => {
      text += `@${uid.split('@')[0]} — ${info.msg} (${formatTime(Date.now() - info.time)} ausente)\n`;
    });
    return sock.sendMessage(groupId, { text, mentions: entries.map(([uid]) => uid) });
  }

  // BANGHOST / INATIVOS
  if (command === '#banghost' || command === '#inativos') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    const days = parseInt(args[0]) || 30;
    const limit = Date.now() - days * 86400000;
    try {
      const meta = await sock.groupMetadata(groupId);
      const activity = userActivity[groupId] || {};
      const inactive = meta.participants.filter(p => {
        if (p.admin) return false;
        const act = activity[p.id];
        return !act || act.lastActive < limit;
      });
      if (!inactive.length) return reply(`Nenhum membro inativo ha mais de ${days} dias!`);
      let text = `*Membros inativos ha +${days} dias:* ${inactive.length}\n\n`;
      inactive.slice(0, 20).forEach(p => { text += `@${p.id.split('@')[0]}\n`; });
      if (inactive.length > 20) text += `\n...e mais ${inactive.length - 20} membros.`;

      if (command === '#banghost') {
        await sock.groupParticipantsUpdate(groupId, inactive.map(p => p.id), 'remove');
        return reply(`${inactive.length} membros fantasmas removidos!`);
      }
      return sock.sendMessage(groupId, { text, mentions: inactive.slice(0, 20).map(p => p.id) });
    } catch (err) { return reply('Erro: ' + err.message); }
  }

  // ===========================================================
  // RANKING / ATIVIDADE
  // ===========================================================

  if (command === '#rankativos') {
    const activity = userActivity[groupId];
    if (!activity || !Object.keys(activity).length) return reply('Nenhuma atividade registrada ainda.');
    const sorted = Object.entries(activity).sort((a, b) => b[1].messageCount - a[1].messageCount).slice(0, 10);
    let text = '*Top 10 Membros Mais Ativos:*\n\n';
    const medals = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
    sorted.forEach(([uid, data], i) => {
      text += `${medals[i]}. @${uid.split('@')[0]} — ${data.messageCount} msgs\n`;
    });
    return sock.sendMessage(groupId, { text, mentions: sorted.map(([uid]) => uid) });
  }

  if (command === '#rankativosg') {
    const activity = userActivity[groupId];
    if (!activity) return reply('Nenhuma atividade registrada.');
    const today = new Date().setHours(0, 0, 0, 0);
    const todayEntries = Object.entries(activity)
      .filter(([, d]) => d.lastActive >= today)
      .sort((a, b) => b[1].messageCount - a[1].messageCount)
      .slice(0, 5);
    if (!todayEntries.length) return reply('Nenhuma atividade hoje.');
    let text = '*Top 5 Ativos Hoje:*\n\n';
    todayEntries.forEach(([uid, data], i) => { text += `${i + 1}. @${uid.split('@')[0]} — ${data.messageCount} msgs\n`; });
    return sock.sendMessage(groupId, { text, mentions: todayEntries.map(([uid]) => uid) });
  }

  // ===========================================================
  // BRINCADEIRAS
  // ===========================================================

  if (command === '#ppt') {
    const opcoes = ['Pedra', 'Papel', 'Tesoura'];
    const bot = opcoes[Math.floor(Math.random() * 3)];
    const user = args[0];
    if (!user) return reply(`Escolha: #ppt [pedra|papel|tesoura]\nBotei: *${bot}*`);
    const u = user.toLowerCase();
    if (!['pedra', 'papel', 'tesoura'].includes(u)) return reply('Escolha entre: pedra, papel ou tesoura');
    let result = '';
    if (u === bot.toLowerCase()) result = 'Empate!';
    else if ((u === 'pedra' && bot === 'Tesoura') || (u === 'papel' && bot === 'Pedra') || (u === 'tesoura' && bot === 'Papel')) result = 'Voce ganhou!';
    else result = 'Eu ganhei!';
    return reply(`Voce: ${user}\nBot: ${bot}\n\n${result}`);
  }

  if (command === '#dado') {
    const lados = parseInt(args[0]) || 6;
    const result = Math.floor(Math.random() * lados) + 1;
    return reply(`Dado de ${lados} lados: *${result}*`);
  }

  if (command === '#porcentagem' || command === '#chance') {
    const text = args.join(' ') || senderName;
    const pct = Math.floor(Math.random() * 101);
    return reply(`${text}: ${pct}%`);
  }

  if (command === '#8ball') {
    const respostas = ['Sim!', 'Nao.', 'Talvez...', 'Com certeza!', 'Definitivamente nao.', 'Provavelmente sim.', 'As perspectivas nao sao boas.', 'Sinais apontam que sim.', 'Pergunte novamente mais tarde.', 'Nao conte com isso.'];
    return reply(`Pergunta: ${args.join(' ')}\n\nResposta: ${respostas[Math.floor(Math.random() * respostas.length)]}`);
  }

  if (command === '#verdadeoudesafio' || command === '#vod') {
    const verdades = ['Qual e o seu maior medo?', 'Voce ja mentiu para um amigo?', 'Qual e a coisa mais embaracosa que ja fez?', 'Voce tem uma queda por alguem do grupo?'];
    const desafios = ['Mande uma foto fazendo careta!', 'Escreva um poema em 2 minutos!', 'Fale em voz alta a musica que estava ouvindo agora!', 'Mande uma selfie agora!'];
    const all = [...verdades.map(t => `Verdade: ${t}`), ...desafios.map(t => `Desafio: ${t}`)];
    return reply(all[Math.floor(Math.random() * all.length)]);
  }

  if (command === '#eujaeununca') {
    const frases = ['Eu ja fui acordado no meio da noite por mensagem no grupo.', 'Eu nunca entendi meme de anime.', 'Eu ja tive mais de 500 mensagens nao lidas.', 'Eu nunca fiz figurinha de foto dos outros.', 'Eu ja enviei mensagem para a pessoa errada.'];
    return reply(frases[Math.floor(Math.random() * frases.length)]);
  }

  if (command === '#casal') {
    try {
      const meta = await sock.groupMetadata(groupId);
      const members = meta.participants;
      if (members.length < 2) return reply('Membros insuficientes.');
      const shuffled = [...members].sort(() => 0.5 - Math.random());
      const p1 = shuffled[0];
      const p2 = shuffled[1];
      return sock.sendMessage(groupId, {
        text: `O casal do dia e:\n@${p1.id.split('@')[0]} + @${p2.id.split('@')[0]}`,
        mentions: [p1.id, p2.id],
      });
    } catch { return reply('Erro ao sortear casal.'); }
  }

  if (command === '#fakemsg') {
    const mentioned = getMentioned(message);
    if (!mentioned.length || args.length < 2) return reply('Use: #fakemsg @usuario [texto]');
    const uid = mentioned[0];
    const txt = args.slice(1).join(' ');
    await sock.sendMessage(groupId, { text: `@${uid.split('@')[0]}: "${txt}"`, mentions: [uid] });
    return;
  }

  if (command === '#bot') {
    const respostas = ['Estou aqui, pode falar!', 'Sim, estou acordado!', 'Presente!', 'Online e pronto para servir!', 'Oi, sou o ' + BOT_NAME + '!'];
    return reply(respostas[Math.floor(Math.random() * respostas.length)]);
  }

  // RANKS DE BRINCADEIRA
  const rankCommands = ['#rankgay', '#rankgado', '#rankcorno', '#rankgostoso', '#rankgostosa', '#rankkenga', '#rankhetero', '#ranknazista', '#rankotaku'];
  if (rankCommands.includes(command)) {
    try {
      const meta = await sock.groupMetadata(groupId);
      const members = meta.participants;
      const winner = members[Math.floor(Math.random() * members.length)];
      const rankName = command.replace('#rank', '').charAt(0).toUpperCase() + command.replace('#rank', '').slice(1);
      const pct = Math.floor(Math.random() * 100) + 1;
      return sock.sendMessage(groupId, {
        text: `*Rank ${rankName} do dia:*\n\n@${winner.id.split('@')[0]} com ${pct}%!`,
        mentions: [winner.id],
      });
    } catch { return reply('Erro ao calcular ranking.'); }
  }

  // ===========================================================
  // ANIVERSARIO
  // ===========================================================

  if (command === '#aniversario') {
    if (!args[0]) return reply('Use: #aniversario [DD/MM]\nEx: #aniversario 25/12');
    const [d, m] = (args[0] || '').split('/').map(Number);
    if (!d || !m || d > 31 || m > 12) return reply('Data invalida. Use DD/MM');
    if (!birthdays[groupId]) birthdays[groupId] = {};
    birthdays[groupId][sender] = { day: d, month: m, name: senderName };
    saveDB('birthdays', birthdays);
    return reply(`Aniversario cadastrado: ${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}`);
  }

  if (command === '#meuaniversario') {
    const b = birthdays[groupId]?.[sender];
    if (!b) return reply('Voce nao cadastrou seu aniversario. Use: #aniversario [DD/MM]');
    return reply(`Seu aniversario: ${String(b.day).padStart(2,'0')}/${String(b.month).padStart(2,'0')}`);
  }

  // ===========================================================
  // FEEDBACK
  // ===========================================================

  if (command === '#feedback') {
    if (!args.length) return reply('Use: #feedback [seu feedback]');
    const fb = args.join(' ');
    await sock.sendMessage(OWNER_JIDS[0], {
      text: `*Feedback recebido!*\nGrupo: ${groupId}\nMembro: @${sender.split('@')[0]} (${senderName})\n\n${fb}`,
    });
    return reply('Feedback enviado ao dono do bot! Obrigado.');
  }

  // ===========================================================
  // GOLD (moeda virtual)
  // ===========================================================

  const goldDB = loadDB('gold');

  const getGold = (uid) => goldDB[uid] || 0;
  const addGold = (uid, amount) => {
    goldDB[uid] = (goldDB[uid] || 0) + amount;
    saveDB('gold', goldDB);
  };
  const setGold = (uid, amount) => { goldDB[uid] = amount; saveDB('gold', goldDB); };

  const dailyDB = loadDB('daily');

  if (command === '#gold') {
    const myGold = getGold(sender);
    return reply(`Seus Golds: *${myGold}*`);
  }

  if (command === '#daily') {
    const lastDaily = dailyDB[sender];
    const now = Date.now();
    const oneDayMs = 86400000;
    if (lastDaily && (now - lastDaily) < oneDayMs) {
      const next = lastDaily + oneDayMs - now;
      return reply(`Voce ja coletou sua recompensa diaria!\nProxima em: ${formatTime(next)}`);
    }
    const reward = Math.floor(Math.random() * 500) + 100;
    addGold(sender, reward);
    dailyDB[sender] = now;
    saveDB('daily', dailyDB);
    return reply(`Recompensa diaria coletada!\n+${reward} Golds!\nTotal: ${getGold(sender)} Golds`);
  }

  if (command === '#rankgold') {
    const sorted = Object.entries(goldDB).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return reply('Nenhum gold registrado ainda.');
    let text = '*Top 10 Ranking de Golds:*\n\n';
    sorted.forEach(([uid, amount], i) => { text += `${i + 1}. @${uid.split('@')[0]} — ${amount} Golds\n`; });
    return sock.sendMessage(groupId, { text, mentions: sorted.map(([uid]) => uid) });
  }

  if (command === '#doargold') {
    const mentioned = getMentioned(message);
    const amount = parseInt(args[1]);
    if (!mentioned.length || isNaN(amount) || amount <= 0) return reply('Use: #doargold @usuario [quantidade]');
    const myGold = getGold(sender);
    if (myGold < amount) return reply(`Golds insuficientes! Voce tem ${myGold} golds.`);
    addGold(sender, -amount);
    addGold(mentioned[0], amount);
    return sock.sendMessage(groupId, {
      text: `@${sender.split('@')[0]} doou ${amount} golds para @${mentioned[0].split('@')[0]}!`,
      mentions: [sender, mentioned[0]],
    });
  }

  if (command === '#minerar_gold') {
    const mineDB = loadDB('mine');
    const lastMine = mineDB[sender];
    const cooldown = 3600000; // 1 hora
    if (lastMine && Date.now() - lastMine < cooldown) {
      return reply(`Aguarde ${formatTime(cooldown - (Date.now() - lastMine))} para minerar novamente.`);
    }
    const amount = Math.floor(Math.random() * 200) + 50;
    addGold(sender, amount);
    mineDB[sender] = Date.now();
    saveDB('mine', mineDB);
    return reply(`Mineracao concluida!\n+${amount} Golds!\nTotal: ${getGold(sender)} Golds`);
  }

  if (command === '#apostar' || command === '#cassino') {
    const amount = parseInt(args[0]);
    if (isNaN(amount) || amount <= 0) return reply('Use: #apostar [quantidade]\nEx: #apostar 100');
    const myGold = getGold(sender);
    if (myGold < amount) return reply(`Golds insuficientes! Voce tem ${myGold} golds.`);
    const win = Math.random() > 0.5;
    if (win) { addGold(sender, amount); return reply(`Voce ganhou ${amount} golds!\nTotal: ${getGold(sender)} Golds`); }
    else { addGold(sender, -amount); return reply(`Voce perdeu ${amount} golds!\nTotal: ${getGold(sender)} Golds`); }
  }

  if (command === '#doublegold') {
    const amount = parseInt(args[0]);
    if (isNaN(amount) || amount <= 0) return reply('Use: #doublegold [quantidade]');
    const myGold = getGold(sender);
    if (myGold < amount) return reply(`Golds insuficientes! Voce tem ${myGold} golds.`);
    const roll = Math.random();
    if (roll > 0.6) { addGold(sender, amount * 2); return reply(`Dobrou! +${amount * 2} golds!\nTotal: ${getGold(sender)} Golds`); }
    else { addGold(sender, -amount); return reply(`Perdeu! -${amount} golds.\nTotal: ${getGold(sender)} Golds`); }
  }

  if (command === '#roubargold') {
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('Use: #roubargold @usuario');
    const target = mentioned[0];
    const targetGold = getGold(target);
    if (targetGold <= 0) return reply('Esse usuario nao tem golds para roubar!');
    const robDB = loadDB('rob');
    if (robDB[sender] && Date.now() - robDB[sender] < 3600000) return reply(`Aguarde ${formatTime(3600000 - (Date.now() - robDB[sender]))} para roubar novamente.`);
    const success = Math.random() > 0.4;
    robDB[sender] = Date.now();
    saveDB('rob', robDB);
    if (success) {
      const amount = Math.floor(targetGold * (Math.random() * 0.3 + 0.1));
      addGold(target, -amount);
      addGold(sender, amount);
      return sock.sendMessage(groupId, { text: `Roubo bem-sucedido! Voce roubou ${amount} golds de @${target.split('@')[0]}!`, mentions: [sender, target] });
    } else {
      const fine = Math.floor(Math.random() * 100) + 50;
      addGold(sender, -fine);
      return sock.sendMessage(groupId, { text: `Roubo falhou! Voce perdeu ${fine} golds de multa!`, mentions: [sender] });
    }
  }

  // ===========================================================
  // INFO / PING / DONO / SENDER
  // ===========================================================

  // ===========================================================
  // PERFIL DO USUÁRIO
  // ===========================================================

  if (command === '#perfil') {
    const mentioned = getMentioned(message);
    const quotedParticipant = getQuotedSender(message);
    const targetUser = quotedParticipant || (mentioned.length ? mentioned[0] : sender);
    const targetName = targetUser === sender ? senderName : (targetUser.split('@')[0]);
    
    // Quantidade de mensagens
    const activity = userActivity[groupId] || {};
    const userAct = activity[targetUser] || { messageCount: 0, lastActive: 0 };
    const msgCount = userAct.messageCount || 0;
    
    // XP (baseado em mensagens: 10xp por mensagem)
    const xp = msgCount * 10;
    const level = Math.floor(xp / 500) + 1;
    const xpNextLevel = (level * 500) - xp;
    
    // Gold
    const goldDB = loadDB('gold');
    const userGold = goldDB[targetUser] || 0;
    
    // Região pelo DDD/DDI
    const userNumber = targetUser.split('@')[0];
    let regiao = 'Desconhecida';
    
    // Mapa de DDDs brasileiros
    const dddMap = {
      '11': 'São Paulo - SP', '12': 'São José dos Campos - SP', '13': 'Santos - SP',
      '14': 'Bauru - SP', '15': 'Sorocaba - SP', '16': 'Ribeirão Preto - SP',
      '17': 'São José do Rio Preto - SP', '18': 'Presidente Prudente - SP', '19': 'Campinas - SP',
      '21': 'Rio de Janeiro - RJ', '22': 'Campos dos Goytacazes - RJ', '24': 'Volta Redonda - RJ',
      '27': 'Vitória - ES', '28': 'Cachoeiro de Itapemirim - ES',
      '31': 'Belo Horizonte - MG', '32': 'Juiz de Fora - MG', '33': 'Governador Valadares - MG',
      '34': 'Uberlândia - MG', '35': 'Poços de Caldas - MG', '37': 'Divinópolis - MG', '38': 'Montes Claros - MG',
      '41': 'Curitiba - PR', '42': 'Ponta Grossa - PR', '43': 'Londrina - PR',
      '44': 'Maringá - PR', '45': 'Foz do Iguaçu - PR', '46': 'Francisco Beltrão - PR',
      '47': 'Joinville - SC', '48': 'Florianópolis - SC', '49': 'Chapecó - SC',
      '51': 'Porto Alegre - RS', '53': 'Pelotas - RS', '54': 'Caxias do Sul - RS', '55': 'Santa Maria - RS',
      '61': 'Brasília - DF', '62': 'Goiânia - GO', '63': 'Palmas - TO', '64': 'Rio Verde - GO',
      '65': 'Cuiabá - MT', '66': 'Rondonópolis - MT', '67': 'Campo Grande - MS', '68': 'Rio Branco - AC', '69': 'Porto Velho - RO',
      '71': 'Salvador - BA', '73': 'Ilhéus - BA', '74': 'Juazeiro - BA', '75': 'Feira de Santana - BA', '77': 'Vitória da Conquista - BA',
      '79': 'Aracaju - SE',
      '81': 'Recife - PE', '82': 'Maceió - AL', '83': 'João Pessoa - PB',
      '84': 'Natal - RN', '85': 'Fortaleza - CE', '86': 'Teresina - PI',
      '87': 'Petrolina - PE', '88': 'Juazeiro do Norte - CE', '89': 'Picos - PI',
      '91': 'Belém - PA', '92': 'Manaus - AM', '93': 'Santarém - PA', '94': 'Marabá - PA',
      '95': 'Boa Vista - RR', '96': 'Macapá - AP', '97': 'Coari - AM', '98': 'São Luís - MA', '99': 'Imperatriz - MA',
    };
    
    // DDI internacionais
    const ddiMap = {
      '1': 'Estados Unidos / Canadá', '44': 'Reino Unido', '351': 'Portugal',
      '34': 'Espanha', '33': 'França', '49': 'Alemanha', '39': 'Itália',
      '81': 'Japão', '82': 'Coreia do Sul', '86': 'China',
      '91': 'Índia', '7': 'Rússia', '52': 'México', '54': 'Argentina',
      '56': 'Chile', '57': 'Colômbia', '58': 'Venezuela', '591': 'Bolívia',
      '595': 'Paraguai', '598': 'Uruguai', '51': 'Peru',
    };
    
    if (userNumber.startsWith('55') && userNumber.length >= 12) {
      // Número brasileiro: 55 + DDD(2) + número(8-9)
      const ddd = userNumber.substring(2, 4);
      regiao = dddMap[ddd] || `Brasil (DDD ${ddd})`;
    } else {
      // Número internacional - tentar detectar DDI
      let found = false;
      for (const [ddi, pais] of Object.entries(ddiMap).sort((a, b) => b[0].length - a[0].length)) {
        if (userNumber.startsWith(ddi)) {
          regiao = pais;
          found = true;
          break;
        }
      }
      if (!found && userNumber.startsWith('55')) {
        regiao = 'Brasil';
      }
    }
    
    // Verificar se é admin
    let isAdminUser = false;
    let cargoUser = 'Membro';
    if (isGroup) {
      isAdminUser = await isAdmin(sock, groupId, targetUser);
      const cargoVal = getCargo(groupId, targetUser);
      if (isOwner(targetUser)) cargoUser = '👑 Dono do Bot';
      else if (isAdminUser) cargoUser = '⭐ Admin';
      else if (cargoVal) cargoUser = `🏷️ ${cargoVal.charAt(0).toUpperCase() + cargoVal.slice(1)}`;
      else cargoUser = '👤 Membro';
    }
    
    // Advertências
    const userWarns = warnings[groupId]?.[targetUser] || [];
    const warnLimit = settings.warningLimit || 3;
    
    // Barra de XP visual
    const xpProgress = Math.min(Math.floor(((xp % 500) / 500) * 10), 10);
    const xpBar = '█'.repeat(xpProgress) + '░'.repeat(10 - xpProgress);
    
    const perfilText = `
╔══════════════════╗
     👤 PERFIL DO USUÁRIO 👤
╚══════════════════╝

📛 *Nick:* ${targetName}
📞 *Número:* +${userNumber}

📊 *ESTATÍSTICAS*
➤ Mensagens: ${msgCount}
➤ XP: ${xp} (Nível ${level})
➤ Próximo nível: ${xpNextLevel} XP
➤ [${xpBar}] ${Math.floor((xp % 500) / 5)}%
➤ Gold: ${userGold} 💰

🌍 *REGIÃO*
➤ ${regiao}

🏅 *CARGO*
➤ ${cargoUser}

⚠️ *ADVERTÊNCIAS*
➤ ${userWarns.length}/${warnLimit}

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`;

    // Tentar enviar com foto de perfil
    try {
      const ppUrl = await sock.profilePictureUrl(targetUser, 'image').catch(() => null);
      if (ppUrl) {
        const ppResp = await axios.get(ppUrl, { responseType: 'arraybuffer', timeout: 10000 });
        return await sock.sendMessage(groupId, {
          image: Buffer.from(ppResp.data),
          caption: perfilText,
          mentions: [targetUser],
        }, { quoted: message });
      }
    } catch {}
    
    return await sock.sendMessage(groupId, {
      text: perfilText,
      mentions: [targetUser],
    }, { quoted: message });
  }

  if (command === '#ping') {
    const start = Date.now();
    await reply('🏓 Pong!');
    const end = Date.now();
    return reply(`⚡ *Latência:* ${end - start}ms\n✅ Bot online e funcionando!`);
  }

  if (command === '#info') {
    return reply(`╔══════════════════╗
     🤖 SIGNABOT INFO 🤖
╚══════════════════╝

🤖 *Nome:* ${BOT_NAME}
📱 *Prefixos:* # / !
⚙️ *Versão:* 2.0
🌐 *Plataforma:* WhatsApp

📌 *Funcionalidades:*
➤ Gerenciamento de grupos
➤ Figurinhas e conversores
➤ Downloads (YouTube/TikTok/Instagram)
➤ Sistema de gold
➤ Diversão e jogos
➤ Sistema de assinatura

💬 *Suporte:*
➤ wa.me/${OWNER_NUMBER}

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#dono') {
    return reply(`╔══════════════════╗
     👑 DONO DO BOT 👑
╚══════════════════╝

👤 *Dono:* SignaBot Owner
📱 *Contato:* wa.me/${OWNER_NUMBER}
💬 *Para contratar ou suporte:*
➤ Acesse o link acima

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#sender') {
    return reply(`╔══════════════════╗
     📱 SUAS INFOS 📱
╚══════════════════╝

👤 *Nome:* ${senderName}
📞 *Número:* ${sender.split('@')[0]}
🆔 *JID:* ${sender}
${isGroup ? `👥 *Grupo:* ${groupId}` : '💬 *Chat privado*'}

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  // ===========================================================
  // UTILIDADES - IMC / CALCULADORA / CEP / SIGNO / CLIMA / HORÁRIO / TRADUZIR
  // ===========================================================

  if (command === '#imc') {
    if (args.length < 2) return reply('❌ Use: #imc [peso em kg] [altura em m]\nEx: #imc 70 1.75');
    const peso = parseFloat(args[0].replace(',', '.'));
    const altura = parseFloat(args[1].replace(',', '.'));
    if (isNaN(peso) || isNaN(altura) || altura <= 0) return reply('❌ Valores inválidos. Ex: #imc 70 1.75');
    const imc = peso / (altura * altura);
    let classificacao = '';
    if (imc < 18.5) classificacao = 'Abaixo do peso';
    else if (imc < 25) classificacao = 'Peso normal';
    else if (imc < 30) classificacao = 'Sobrepeso';
    else if (imc < 35) classificacao = 'Obesidade grau I';
    else if (imc < 40) classificacao = 'Obesidade grau II';
    else classificacao = 'Obesidade grau III (mórbida)';
    return reply(`*Cálculo de IMC*\n\n⚖️ Peso: ${peso}kg\n📏 Altura: ${altura}m\n📊 IMC: ${imc.toFixed(2)}\n🏷️ Classificação: ${classificacao}`);
  }

  if (command === '#calculadora' || command === '#calc') {
    if (!args.length) return reply('❌ Use: #calculadora [expressão]\nEx: #calculadora 2+2*3');
    const expr = args.join(' ').replace(/[^0-9+\-*/().\s]/g, '');
    try {
      // eslint-disable-next-line no-new-func
      const result = Function('"use strict"; return (' + expr + ')')();
      return reply(`🧮 *Calculadora*\n\n📝 Expressão: ${expr}\n✅ Resultado: *${result}*`);
    } catch {
      return reply('❌ Expressão inválida. Use operadores: + - * /\nEx: #calculadora (5+3)*2');
    }
  }

  if (command === '#cep') {
    if (!args[0]) return reply('❌ Use: #cep [CEP]\nEx: #cep 01310100');
    const cep = args[0].replace(/\D/g, '');
    if (cep.length !== 8) return reply('❌ CEP inválido. Deve ter 8 dígitos.');
    try {
      const { data } = await axios.get(`https://viacep.com.br/ws/${cep}/json/`, { timeout: 10000 });
      if (data.erro) return reply('❌ CEP não encontrado.');
      return reply(`*Consulta de CEP*\n\n📮 CEP: ${data.cep}\n🏘️ Logradouro: ${data.logradouro || '-'}\n🏙️ Bairro: ${data.bairro || '-'}\n🌆 Cidade: ${data.localidade}\n🗺️ Estado: ${data.uf}\n🌎 Região: ${data.regiao || '-'}`);
    } catch {
      return reply('❌ Erro ao consultar CEP. Tente novamente.');
    }
  }

  if (command === '#signo') {
    if (!args[0]) return reply('❌ Use: #signo [DD/MM]\nEx: #signo 25/12');
    const parts = args[0].split('/');
    const dia = parseInt(parts[0]);
    const mes = parseInt(parts[1]);
    if (!dia || !mes || dia > 31 || mes > 12) return reply('❌ Data inválida. Use DD/MM');
    const signos = [
      { nome: 'Capricórnio', inicio: [12, 22], fim: [1, 19] },
      { nome: 'Aquário', inicio: [1, 20], fim: [2, 18] },
      { nome: 'Peixes', inicio: [2, 19], fim: [3, 20] },
      { nome: 'Áries', inicio: [3, 21], fim: [4, 19] },
      { nome: 'Touro', inicio: [4, 20], fim: [5, 20] },
      { nome: 'Gêmeos', inicio: [5, 21], fim: [6, 20] },
      { nome: 'Câncer', inicio: [6, 21], fim: [7, 22] },
      { nome: 'Leão', inicio: [7, 23], fim: [8, 22] },
      { nome: 'Virgem', inicio: [8, 23], fim: [9, 22] },
      { nome: 'Libra', inicio: [9, 23], fim: [10, 22] },
      { nome: 'Escorpião', inicio: [10, 23], fim: [11, 21] },
      { nome: 'Sagitário', inicio: [11, 22], fim: [12, 21] },
    ];
    let signo = 'Capricórnio';
    for (const s of signos) {
      const [mi, di] = s.inicio;
      const [mf, df] = s.fim;
      if ((mes === mi && dia >= di) || (mes === mf && dia <= df)) { signo = s.nome; break; }
    }
    return reply(`*Seu Signo*\n\n📅 Data: ${String(dia).padStart(2,'0')}/${String(mes).padStart(2,'0')}\n✨ Signo: *${signo}*`);
  }

  if (command === '#clima') {
    if (!args.length) return reply('❌ Use: #clima [cidade]\nEx: #clima Manaus');
    const city = encodeURIComponent(args.join(' '));
    try {
      const { data } = await axios.get(
        `https://wttr.in/${city}?format=j1`,
        { timeout: 10000 }
      );
      const current = data.current_condition?.[0];
      const area = data.nearest_area?.[0];
      if (!current) return reply('❌ Cidade não encontrada.');
      const cityName = area?.areaName?.[0]?.value || args.join(' ');
      const country = area?.country?.[0]?.value || '';
      const temp = current.temp_C;
      const feels = current.FeelsLikeC;
      const desc = current.weatherDesc?.[0]?.value || '';
      const humidity = current.humidity;
      const wind = current.windspeedKmph;
      return reply(`*Clima em ${cityName}, ${country}*\n\n🌡️ Temperatura: ${temp}°C\n🤔 Sensação: ${feels}°C\n☁️ Condição: ${desc}\n💧 Umidade: ${humidity}%\n💨 Vento: ${wind} km/h`);
    } catch {
      return reply('❌ Erro ao buscar clima. Verifique o nome da cidade.');
    }
  }

  if (command === '#horario') {
    const agora = new Date();
    const dataFmt = agora.toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const horaFmt = agora.toLocaleTimeString('pt-BR');
    return reply(`*Horário Atual*\n\n📅 Data: ${dataFmt}\n🕐 Hora: ${horaFmt}\n🌐 Fuso: America/Sao_Paulo`);
  }

  if (command === '#traduzir' || command === '#tr') {
    if (args.length < 2) return reply('❌ Use: #traduzir [idioma] [texto]\nIdiomas: en (inglês), es (espanhol), fr (francês), de (alemão), pt (português)\nEx: #traduzir en Olá mundo');
    const lang = args[0].toLowerCase();
    const text = args.slice(1).join(' ');
    try {
      const { data } = await axios.get(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=pt|${lang}`,
        { timeout: 10000 }
      );
      const translated = data?.responseData?.translatedText;
      if (!translated || data.responseStatus !== 200) return reply('❌ Erro ao traduzir. Verifique o idioma e tente novamente.');
      return reply(`*Tradução*\n\n📝 Original (pt): ${text}\n🌐 Traduzido (${lang}): ${translated}`);
    } catch {
      return reply('❌ Erro ao traduzir. Tente novamente mais tarde.');
    }
  }

  // ===========================================================
  // #SHIP - COMPATIBILIDADE ENTRE DOIS USUÁRIOS
  // ===========================================================

  if (command === '#ship') {
    const mentioned = getMentioned(message);
    if (mentioned.length < 2) return reply('❌ Use: #ship @usuario1 @usuario2');
    const p1 = mentioned[0];
    const p2 = mentioned[1];
    const pct = Math.floor(Math.random() * 101);
    let emoji = pct >= 80 ? '💕' : pct >= 60 ? '❤️' : pct >= 40 ? '💛' : pct >= 20 ? '💔' : '❌';
    return sock.sendMessage(groupId, {
      text: `*Compatibilidade de Casal*\n\n👤 @${p1.split('@')[0]}\n💞 x\n👤 @${p2.split('@')[0]}\n\n${emoji} Compatibilidade: *${pct}%*`,
      mentions: [p1, p2],
    });
  }

  // ===========================================================
  // TECNOLOGIA - TODOS OS COMANDOS
  // ===========================================================

  if (command === '#testarnet' || command === '#velocidade') {
    return reply(`
╔══════════════════╗
     🌐 TESTE DE VELOCIDADE 🌐
╚══════════════════╝

📡 *Como testar sua velocidade:*

1️⃣ *Pelo navegador:*
   ➤ Acesse: https://fast.com
   ➤ Ou: https://speedtest.net
   ➤ Clique em "Iniciar" e aguarde

2️⃣ *Pelo celular:*
   ➤ Baixe o app "Speedtest by Ookla"
   ➤ Disponível na Play Store e App Store
   ➤ Abra e toque em "Iniciar"

3️⃣ *Entendendo os resultados:*
   ➤ *Download:* Velocidade de recebimento
   ➤ *Upload:* Velocidade de envio
   ➤ *Ping:* Tempo de resposta (menor = melhor)
   ➤ *Jitter:* Variação do ping

4️⃣ *Velocidades ideais:*
   ➤ Navegar: 5-10 Mbps
   ➤ Streaming HD: 25 Mbps
   ➤ Streaming 4K: 50 Mbps
   ➤ Jogos online: 25+ Mbps, Ping < 50ms
   ➤ Videochamada: 10 Mbps

💡 *Dica:* Teste conectado ao Wi-Fi E
   aos dados móveis para comparar!

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#siteseguro' || command === '#verificarlink') {
    if (!args.length) return reply('❌ Use: #siteseguro [url]\nEx: #siteseguro https://google.com');
    const url = args[0];
    
    let analise = [];
    
    // Verificações básicas de segurança
    const isHttps = url.startsWith('https://');
    analise.push(isHttps ? '✅ Usa HTTPS (conexão segura)' : '⚠️ NÃO usa HTTPS (conexão insegura!)');
    
    // Verificar domínios suspeitos
    const suspiciousPatterns = [
      /bit\.ly/i, /tinyurl/i, /goo\.gl/i, /t\.co/i, /is\.gd/i,
      /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, // IP direto
      /free.*prize/i, /win.*money/i, /click.*here/i
    ];
    const isSuspicious = suspiciousPatterns.some(p => p.test(url));
    analise.push(isSuspicious ? '⚠️ URL suspeita (encurtador ou padrão duvidoso)' : '✅ URL com formato normal');
    
    // Verificar extensão suspeita
    const suspiciousExt = ['.exe', '.bat', '.cmd', '.scr', '.js', '.vbs', '.msi', '.apk'];
    const hasSuspiciousExt = suspiciousExt.some(ext => url.toLowerCase().includes(ext));
    analise.push(hasSuspiciousExt ? '🚨 CUIDADO! Link pode ser um arquivo executável!' : '✅ Não aponta para executável');
    
    // Verificar domínios conhecidos
    const trustedDomains = ['google.com', 'youtube.com', 'facebook.com', 'instagram.com', 'twitter.com', 'github.com', 'microsoft.com', 'apple.com', 'amazon.com', 'netflix.com', 'whatsapp.com', 'wikipedia.org', 'linkedin.com'];
    const isTrusted = trustedDomains.some(d => url.includes(d));
    analise.push(isTrusted ? '✅ Domínio reconhecido e confiável' : 'ℹ️ Domínio não está na lista de conhecidos');
    
    // Verificar caracteres estranhos (homograph attack)
    const hasWeirdChars = /[^\x00-\x7F]/.test(url);
    analise.push(hasWeirdChars ? '🚨 ALERTA! Contém caracteres incomuns (possível phishing)' : '✅ Sem caracteres suspeitos');

    // Score de segurança
    let score = 50;
    if (isHttps) score += 20;
    if (!isSuspicious) score += 10;
    if (!hasSuspiciousExt) score += 10;
    if (isTrusted) score += 15;
    if (!hasWeirdChars) score += 10;
    if (!isHttps) score -= 20;
    if (isSuspicious) score -= 15;
    if (hasSuspiciousExt) score -= 25;
    if (hasWeirdChars) score -= 20;
    score = Math.max(0, Math.min(100, score));
    
    let status = score >= 80 ? '🟢 SEGURO' : score >= 50 ? '🟡 ATENÇÃO' : '🔴 PERIGOSO';

    return reply(`
╔══════════════════╗
     🔒 ANÁLISE DE SEGURANÇA 🔒
╚══════════════════╝

🌐 *URL:* ${url}

📊 *Score:* ${score}/100 — ${status}

📋 *Análise:*
${analise.join('\n')}

🔍 *Para análise avançada:*
➤ https://www.virustotal.com
➤ https://transparencyreport.google.com
➤ https://urlscan.io

💡 *Dicas de segurança:*
➤ Nunca clique em links desconhecidos
➤ Verifique se tem cadeado (HTTPS)
➤ Desconfie de ofertas muito boas
➤ Não insira dados pessoais em sites duvidosos

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#senhasegura') {
    if (!args.length) return reply('❌ Use: #senhasegura [sua senha]\nEx: #senhasegura MinhaSenh@123');
    const senha = args.join(' ');
    let score = 0;
    let dicas = [];
    
    if (senha.length >= 8) { score += 20; } else { dicas.push('➤ Use pelo menos 8 caracteres'); }
    if (senha.length >= 12) { score += 10; }
    if (senha.length >= 16) { score += 10; }
    if (/[a-z]/.test(senha)) { score += 10; } else { dicas.push('➤ Adicione letras minúsculas'); }
    if (/[A-Z]/.test(senha)) { score += 15; } else { dicas.push('➤ Adicione letras MAIÚSCULAS'); }
    if (/\d/.test(senha)) { score += 15; } else { dicas.push('➤ Adicione números'); }
    if (/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(senha)) { score += 20; } else { dicas.push('➤ Adicione caracteres especiais (!@#$%)'); }
    
    // Penalidades
    if (/^[0-9]+$/.test(senha)) { score -= 20; dicas.push('➤ Não use apenas números'); }
    if (/(.)\1{2,}/.test(senha)) { score -= 10; dicas.push('➤ Evite caracteres repetidos (aaa, 111)'); }
    if (/123|abc|qwerty|senha|password/i.test(senha)) { score -= 20; dicas.push('➤ Evite sequências comuns'); }
    
    score = Math.max(0, Math.min(100, score));
    let nivel = score >= 80 ? '🟢 FORTE' : score >= 50 ? '🟡 MÉDIA' : '🔴 FRACA';

    return reply(`
╔══════════════════╗
     🔐 ANÁLISE DE SENHA 🔐
╚══════════════════╝

📊 *Força:* ${score}/100 — ${nivel}
📏 *Tamanho:* ${senha.length} caracteres

${dicas.length ? '💡 *Sugestões de melhoria:*\n' + dicas.join('\n') : '✅ Sua senha está boa!'}

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#gerarsenha') {
    const tamanho = parseInt(args[0]) || 16;
    if (tamanho < 6 || tamanho > 64) return reply('❌ Tamanho deve ser entre 6 e 64.');
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*()-_=+';
    let senha = '';
    for (let i = 0; i < tamanho; i++) {
      senha += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return reply(`
╔══════════════════╗
     🔑 GERADOR DE SENHA 🔑
╚══════════════════╝

🔐 *Sua senha gerada:*
\`\`\`${senha}\`\`\`

📏 Tamanho: ${tamanho} caracteres
🛡️ Força: ALTA

💡 *Dica:* Copie e salve em um
   gerenciador de senhas!

╔══════════════════╝
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#resetarmodem') {
    return reply(`
╔══════════════════╗
     📡 RESETAR MODEM/ROTEADOR 📡
╚══════════════════╝

🔄 *Método 1 — Reset Simples:*
1. Desligue o modem da tomada
2. Aguarde 30 segundos
3. Ligue novamente
4. Espere 2-3 minutos para reconectar

🔧 *Método 2 — Reset pelo Botão:*
1. Encontre o botão "Reset" (geralmente atrás)
2. Use um palito ou clipe
3. Pressione e segure por 10 segundos
4. Solte e aguarde reiniciar
⚠️ AVISO: Isso apaga TODAS as configurações!

💻 *Método 3 — Pelo Navegador:*
1. Abra o navegador
2. Digite: 192.168.0.1 ou 192.168.1.1
3. Login padrão: admin / admin
4. Vá em "Sistema" ou "Manutenção"
5. Clique em "Reiniciar" ou "Restaurar"

📞 *Senhas padrão dos modems:*
➤ Vivo: admin / vivo12345
➤ Claro: admin / gvt12345
➤ Oi: admin / admin
➤ NET: admin / admin ou NET_XXXX
➤ TIM: admin / admin

💡 *Dica:* Sempre anote suas configurações
   de Wi-Fi ANTES de resetar!

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#melhorarsinal') {
    return reply(`
╔══════════════════╗
     📶 MELHORAR SINAL WI-FI 📶
╚══════════════════╝

📍 *POSICIONAMENTO*
➤ Coloque o roteador no centro da casa
➤ Mantenha elevado (em cima de móvel)
➤ Longe de paredes grossas e espelhos
➤ Longe de micro-ondas e telefones

📡 *CONFIGURAÇÕES*
➤ Mude o canal do Wi-Fi (1, 6 ou 11)
➤ Use banda 5GHz para perto do roteador
➤ Use banda 2.4GHz para longe
➤ Altere para canal menos congestionado

🔧 *SOLUÇÕES*
➤ Use repetidor/extensor de sinal
➤ Use sistema Mesh para casas grandes
➤ Powerline (internet pela tomada)
➤ Cabo ethernet para dispositivos fixos

📱 *NO CELULAR*
➤ Esqueça a rede e reconecte
➤ Desligue e ligue o Wi-Fi
➤ Reinicie o celular
➤ Limpe o cache de rede

💡 *Dica:* Use o app "WiFi Analyzer"
   para encontrar o melhor canal!

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#meuip') {
    try {
      const { data } = await axios.get('https://api.ipify.org?format=json', { timeout: 10000 });
      return reply(`
╔══════════════════╗
     🌐 SEU IP PÚBLICO 🌐
╚══════════════════╝

📡 *IP:* ${data.ip}

💡 *O que é IP?*
É o endereço do seu dispositivo
na internet. Cada conexão tem um.

⚠️ *Dica de segurança:*
➤ Não compartilhe seu IP publicamente
➤ Use VPN para proteger sua privacidade

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
    } catch {
      return reply('❌ Erro ao obter IP. Tente novamente.');
    }
  }

  if (command === '#meudns') {
    return reply(`
╔══════════════════╗
     🌐 CONFIGURAR DNS 🌐
╚══════════════════╝

📡 *DNS Recomendados:*

☁️ *Cloudflare (mais rápido):*
➤ Primário: 1.1.1.1
➤ Secundário: 1.0.0.1

🔍 *Google:*
➤ Primário: 8.8.8.8
➤ Secundário: 8.8.4.4

🛡️ *OpenDNS (com filtro):*
➤ Primário: 208.67.222.222
➤ Secundário: 208.67.220.220

👨‍👩‍👧 *AdGuard (bloqueia anúncios):*
➤ Primário: 94.140.14.14
➤ Secundário: 94.140.15.15

📱 *Como configurar no Android:*
1. Configurações > Wi-Fi
2. Toque na sua rede > Avançado
3. Mude DNS para "Estático"
4. Insira os endereços acima

💻 *Como configurar no PC:*
1. Painel de Controle > Rede
2. Propriedades do adaptador
3. Protocolo IPv4 > Propriedades
4. "Usar os seguintes endereços DNS"

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#pingtest') {
    const host = args[0] || 'google.com';
    try {
      const start = Date.now();
      await axios.get(`https://${host}`, { timeout: 10000 });
      const ping = Date.now() - start;
      let status = ping < 100 ? '🟢 Excelente' : ping < 300 ? '🟡 Bom' : '🔴 Lento';
      return reply(`
╔══════════════════╗
     📡 PING TEST 📡
╚══════════════════╝

🌐 *Host:* ${host}
⏱️ *Ping:* ${ping}ms
📊 *Status:* ${status}

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
    } catch {
      return reply(`❌ Não foi possível alcançar ${host}. Verifique o endereço.`);
    }
  }

  if (command === '#limparcache') {
    return reply(`
╔══════════════════╗
     🧹 LIMPAR CACHE 🧹
╚══════════════════╝

📱 *Android:*
➤ Configurações > Armazenamento > Cache
➤ Ou por app: Config > Apps > [App] > Limpar cache

🍎 *iPhone:*
➤ Safari: Ajustes > Safari > Limpar dados
➤ Apps: Deletar e reinstalar o app

💻 *Windows:*
➤ Win+R > digite "temp" > deletar tudo
➤ Win+R > digite "%temp%" > deletar tudo
➤ Limpeza de Disco (cleanmgr)

🌐 *Navegadores:*
➤ Chrome: Ctrl+Shift+Del
➤ Firefox: Ctrl+Shift+Del
➤ Edge: Ctrl+Shift+Del

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#economizarbateria') {
    return reply(`
╔══════════════════╗
     🔋 ECONOMIZAR BATERIA 🔋
╚══════════════════╝

📱 *Dicas essenciais:*
➤ Reduza o brilho da tela
➤ Ative o modo economia de energia
➤ Desative GPS quando não usar
➤ Desative Bluetooth e NFC
➤ Use Wi-Fi ao invés de dados móveis
➤ Feche apps em segundo plano
➤ Desative atualizações automáticas
➤ Use modo escuro (telas AMOLED)
➤ Reduza o tempo de tela ligada
➤ Desative assistente de voz

⚡ *Apps que mais gastam:*
➤ Redes sociais (Facebook, Instagram)
➤ Jogos
➤ Streaming de vídeo
➤ GPS/Mapas

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#liberarmemoria') {
    return reply(`
╔══════════════════╗
     💾 LIBERAR MEMÓRIA 💾
╚══════════════════╝

📱 *Android:*
➤ Desinstale apps não usados
➤ Limpe cache dos apps
➤ Mova fotos para nuvem (Google Fotos)
➤ Apague downloads antigos
➤ Limpe conversas do WhatsApp
➤ Use "Files by Google" para limpeza

🍎 *iPhone:*
➤ Ajustes > Geral > Armazenamento
➤ Descarregue apps não usados
➤ Limpe fotos e vídeos
➤ Limpe anexos do WhatsApp/Telegram

💻 *PC:*
➤ Desinstale programas não usados
➤ Use Limpeza de Disco
➤ Mova arquivos para HD externo
➤ Esvazie a lixeira regularmente

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#modoaviao') {
    return reply(`
╔══════════════════╗
     ✈️ MODO AVIÃO — DICAS ✈️
╚══════════════════╝

📱 *Usos inteligentes:*

1️⃣ *Carregar mais rápido*
   Ative modo avião ao carregar e
   o celular carrega até 2x mais rápido!

2️⃣ *Resolver problemas de rede*
   Sem sinal? Ative e desative o modo
   avião — funciona como um reset!

3️⃣ *Economizar bateria*
   Em áreas sem sinal, ative para
   evitar que o celular fique buscando rede.

4️⃣ *Sem interrupções*
   Perfeito para estudar, dormir ou
   quando precisa de foco total.

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#dicatech') {
    const dicas = [
      '💡 Use Ctrl+Shift+T para reabrir abas fechadas no navegador!',
      '💡 No Android, pressione e segure o botão de power 5x rapidamente para ligar para emergência.',
      '💡 No WhatsApp, digite *texto* para negrito, _texto_ para itálico e ~texto~ para tachado.',
      '💡 Ctrl+L seleciona toda a barra de endereço do navegador instantaneamente.',
      '💡 Use o Google como calculadora: digite a conta direto na busca!',
      '💡 Print Screen + Windows abre a ferramenta de recorte no Windows 11.',
      '💡 No YouTube, pressione K para pausar, J para voltar 10s e L para avançar 10s.',
      '💡 Digite "chrome://flags" no Chrome para acessar funções experimentais.',
      '💡 No Android, fale "Ok Google, onde está meu celular?" de outro dispositivo para encontrá-lo.',
      '💡 Ctrl+F permite buscar qualquer palavra em qualquer página ou documento.',
      '💡 Use sites como haveibeenpwned.com para verificar se seu email já foi vazado.',
      '💡 No WhatsApp Web, Ctrl+Shift+M muta uma conversa rapidamente.',
      '💡 Alt+Tab alterna entre janelas abertas no Windows.',
      '💡 No celular, sacudir o aparelho desfaz a última ação no iPhone.',
      '💡 Use 2FA (autenticação em dois fatores) em TODAS as suas contas importantes!',
      '💡 Ctrl+D salva a página atual nos favoritos do navegador.',
      '💡 No Google Maps, segure um local para ver o trânsito em tempo real.',
      '💡 Windows+V abre o histórico da área de transferência (clipboard).',
      '💡 Use DNS 1.1.1.1 (Cloudflare) para navegar mais rápido!',
      '💡 No WhatsApp, envie uma mensagem para si mesmo — funciona como bloco de notas!',
    ];
    return reply(dicas[Math.floor(Math.random() * dicas.length)]);
  }

  if (command === '#atalhos') {
    const sistema = (args[0] || 'windows').toLowerCase();
    
    if (sistema === 'windows' || sistema === 'win') {
      return reply(`
╔══════════════════╗
     ⌨️ ATALHOS WINDOWS ⌨️
╚══════════════════╝

📋 *Básicos:*
➤ Ctrl+C — Copiar
➤ Ctrl+V — Colar
➤ Ctrl+Z — Desfazer
➤ Ctrl+A — Selecionar tudo
➤ Ctrl+S — Salvar
➤ Alt+F4 — Fechar janela

🖥️ *Sistema:*
➤ Win+E — Explorador de arquivos
➤ Win+D — Mostrar desktop
➤ Win+L — Bloquear PC
➤ Win+I — Configurações
➤ Win+V — Área de transferência
➤ Win+PrintScreen — Captura de tela
➤ Ctrl+Shift+Esc — Gerenciador de tarefas

🌐 *Navegador:*
➤ Ctrl+T — Nova aba
➤ Ctrl+W — Fechar aba
➤ Ctrl+Shift+T — Reabrir aba
➤ Ctrl+L — Barra de endereço
➤ F5 — Atualizar página

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
    }
    
    if (sistema === 'mac' || sistema === 'apple') {
      return reply(`
╔══════════════════╗
     ⌨️ ATALHOS MAC ⌨️
╚══════════════════╝

📋 *Básicos:*
➤ Cmd+C — Copiar
➤ Cmd+V — Colar
➤ Cmd+Z — Desfazer
➤ Cmd+A — Selecionar tudo
➤ Cmd+S — Salvar
➤ Cmd+Q — Fechar app

🖥️ *Sistema:*
➤ Cmd+Space — Spotlight
➤ Cmd+Tab — Alternar apps
➤ Cmd+Shift+3 — Screenshot
➤ Cmd+Shift+4 — Screenshot parcial
➤ Cmd+Option+Esc — Forçar saída

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
    }

    if (sistema === 'android' || sistema === 'celular') {
      return reply(`
╔══════════════════╗
     ⌨️ DICAS ANDROID ⌨️
╚══════════════════╝

📱 *Atalhos úteis:*
➤ Power 2x — Abrir câmera
➤ Power 5x — Emergência (SOS)
➤ Vol- + Power — Screenshot
➤ Segurar app — Atalhos rápidos
➤ Arrastar 2 dedos — Painel rápido

⚡ *Gestos:*
➤ Deslizar de baixo — Voltar ao início
➤ Deslizar do lado — Voltar
➤ Deslizar de baixo + segurar — Apps recentes

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
    }

    return reply('❌ Use: #atalhos [windows/mac/android]');
  }

  if (command === '#formatarpc') {
    return reply(`
╔══════════════════╗
     💻 FORMATAR PC 💻
╚══════════════════╝

⚠️ *ANTES DE FORMATAR:*
➤ Faça backup de TODOS os arquivos!
➤ Salve senhas e favoritos
➤ Anote drivers necessários
➤ Tenha pendrive com Windows (8GB+)

🔧 *Passo a passo:*
1. Baixe a ISO do Windows em:
   microsoft.com/software-download
2. Use o "Media Creation Tool"
3. Crie um pendrive bootável
4. Reinicie o PC e acesse a BIOS
   (F2, F12, Del ou Esc ao ligar)
5. Coloque o pendrive como boot primário
6. Siga as instruções de instalação
7. Escolha "Instalação personalizada"
8. Formate a partição desejada
9. Instale o Windows

📦 *Após formatar:*
➤ Instale drivers (chipset, vídeo, rede)
➤ Ative o Windows
➤ Instale antivírus
➤ Restaure seus backups

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#atualizardriver') {
    return reply(`
╔══════════════════╗
     🔄 ATUALIZAR DRIVERS 🔄
╚══════════════════╝

💻 *Windows:*
1. Win+X > Gerenciador de Dispositivos
2. Clique com direito no dispositivo
3. "Atualizar driver"
4. "Pesquisar automaticamente"

🎮 *Placa de Vídeo:*
➤ NVIDIA: nvidia.com/drivers
➤ AMD: amd.com/support
➤ Intel: intel.com/drivers

🔧 *Ferramentas automáticas:*
➤ Driver Booster (IObit)
➤ Snappy Driver Installer
➤ Windows Update (mais seguro)

⚠️ *Dicas:*
➤ Crie ponto de restauração antes
➤ Baixe drivers APENAS do site oficial
➤ Nunca use sites de terceiros!

╔══════════════════╗
      ⚡ SignaBOT ⚡
��══════════════════╝`);
  }

  if (command === '#vpn') {
    return reply(`
╔══════════════════╗
     🛡️ VPN — O QUE É? 🛡️
╚══════════════════╝

❓ *O que é VPN?*
➤ Rede Privada Virtual
➤ Protege sua conexão criptografando
➤ Esconde seu IP real
➤ Permite acessar conteúdo de outros países

📱 *VPNs Grátis Confiáveis:*
➤ ProtonVPN (sem limite de dados)
➤ Windscribe (10GB/mês)
➤ Cloudflare WARP (1.1.1.1 app)

💰 *VPNs Pagas (melhores):*
➤ NordVPN
➤ ExpressVPN
➤ Surfshark
➤ Mullvad

⚠️ *Cuidado com:*
➤ VPNs grátis desconhecidas
➤ VPNs que pedem muitas permissões
➤ VPNs sem política de no-log

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  if (command === '#whoisdominio') {
    if (!args.length) return reply('❌ Use: #whoisdominio [domínio]\nEx: #whoisdominio google.com');
    const dominio = args[0].replace(/https?:\/\//, '').split('/')[0];
    try {
      const { data } = await axios.get(`https://api.api-ninjas.com/v1/whois?domain=${encodeURIComponent(dominio)}`, {
        timeout: 10000,
        headers: { 'X-Api-Key': 'free' }
      });
      
      return reply(`
╔══════════════════╗
     🌐 WHOIS — ${dominio} 🌐
╚══════════════════╝

📛 *Domínio:* ${data.domain_name || dominio}
📅 *Criado em:* ${data.creation_date ? new Date(data.creation_date * 1000).toLocaleDateString('pt-BR') : 'N/D'}
📅 *Expira em:* ${data.expiration_date ? new Date(data.expiration_date * 1000).toLocaleDateString('pt-BR') : 'N/D'}
🏢 *Registrador:* ${data.registrar || 'N/D'}
🌍 *DNS:* ${Array.isArray(data.name_servers) ? data.name_servers.slice(0, 3).join(', ') : 'N/D'}

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
    } catch {
      return reply(`
╔══════════════════╗
     🌐 WHOIS — ${dominio} 🌐
╚══════════════════╝

ℹ️ Não foi possível consultar o WHOIS.

🔍 *Consulte manualmente:*
➤ https://who.is/${dominio}
➤ https://registro.br/tecnologia/ferramentas/whois/

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
    }
  }

  if (command === '#portacheck') {
    const porta = parseInt(args[0]);
    if (!porta || porta < 1 || porta > 65535) return reply('❌ Use: #portacheck [porta]\nEx: #portacheck 80\nPortas comuns: 80 (HTTP), 443 (HTTPS), 21 (FTP), 22 (SSH), 3306 (MySQL)');
    
    const portasConhecidas = {
      20: 'FTP (dados)', 21: 'FTP (controle)', 22: 'SSH', 23: 'Telnet',
      25: 'SMTP (email)', 53: 'DNS', 80: 'HTTP', 110: 'POP3',
      143: 'IMAP', 443: 'HTTPS', 993: 'IMAPS', 995: 'POP3S',
      3306: 'MySQL', 5432: 'PostgreSQL', 27017: 'MongoDB',
      3389: 'Remote Desktop', 8080: 'HTTP Alternativo', 8443: 'HTTPS Alternativo'
    };

    return reply(`
╔══════════════════╗
     🔌 INFO DA PORTA ${porta} 🔌
╚══════════════════╝

🔢 *Porta:* ${porta}
📋 *Serviço:* ${portasConhecidas[porta] || 'Desconhecido/Personalizado'}
📊 *Tipo:* ${porta <= 1023 ? 'Bem conhecida (0-1023)' : porta <= 49151 ? 'Registrada (1024-49151)' : 'Dinâmica (49152-65535)'}

🔍 *Verificar se está aberta:*
➤ Use: https://www.yougetsignal.com/tools/open-ports/
➤ Ou: https://canyouseeme.org

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`);
  }

  // ===========================================================
  // COMANDOS PERSONALIZADOS — CRIAR / USAR / LISTAR / DELETAR
  // ===========================================================

  // !comando [nome] [texto] (pode incluir imagem na mensagem)
  if (command === '#comando') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Apenas admins e mods podem criar comandos.');
    
    if (!args.length) return reply('❌ Use: !comando [nome] [texto]\nEnvie com uma imagem para associar ao comando!\n\nExemplo:\n!comando saudacao Olá pessoal, bem-vindos!');
    
    const cmdName = args[0].toLowerCase();
    const cmdText = args.slice(1).join(' ');
    
    if (!cmdText && !message.message?.imageMessage) {
      return reply('❌ Você precisa fornecer um texto e/ou imagem!\n\nUso: !comando [nome] [texto]\nOu envie uma imagem com a legenda: !comando [nome] [texto]');
    }
    
    // Verificar se há imagem na mensagem
    const imageMsg = message.message?.imageMessage;
    let imageBuffer = null;
    let imagePath = null;
    
    if (imageMsg) {
      try {
        imageBuffer = await downloadMedia(imageMsg, 'image');
        if (imageBuffer) {
          // Salvar a imagem no diretório de dados
          const imgDir = path.join(DATA_DIR, 'cmd_images');
          if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
          imagePath = path.join(imgDir, `${groupId.replace('@g.us', '')}_${cmdName}_${Date.now()}.jpg`);
          fs.writeFileSync(imagePath, imageBuffer);
        }
      } catch (err) {
        console.log('[COMANDO] Erro ao salvar imagem:', err.message);
        logBotError('cmd_save_image', err);
      }
    }
    
    // Salvar o comando
    if (!customCmds[groupId]) customCmds[groupId] = {};
    
    // Se já existia um comando com esse nome e tinha imagem, deletar a imagem antiga
    if (customCmds[groupId][cmdName] && customCmds[groupId][cmdName].imagePath) {
      try { fs.unlinkSync(customCmds[groupId][cmdName].imagePath); } catch {}
    }
    
    customCmds[groupId][cmdName] = {
      text: cmdText || '',
      imagePath: imagePath,
      creator: sender,
      createdAt: Date.now()
    };
    saveDB('customCmds', customCmds);
    
    let confirmMsg = `✅ Comando *!${cmdName}* criado com sucesso!\n\n`;
    if (cmdText) confirmMsg += `📝 Texto: ${cmdText}\n`;
    if (imagePath) confirmMsg += `🖼️ Imagem: Anexada\n`;
    confirmMsg += `\n💡 Para usar: !${cmdName}`;
    
    return reply(confirmMsg);
  }

  // #vercomandos — Listar todos os comandos personalizados do grupo
  if (command === '#vercomandos' || command === '#listacmd') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    
    const cmds = customCmds[groupId];
    if (!cmds || !Object.keys(cmds).length) {
      return reply('📋 Nenhum comando personalizado criado neste grupo.\n\nUse !comando [nome] [texto] para criar!');
    }
    
    let text = `
╔══════════════════╗
     📋 COMANDOS DO GRUPO 📋
╚══════════════════╝

`;
    Object.entries(cmds).forEach(([name, cmd], i) => {
      const hasImg = cmd.imagePath ? '🖼️' : '📝';
      const preview = cmd.text ? (cmd.text.length > 40 ? cmd.text.substring(0, 40) + '...' : cmd.text) : '(somente imagem)';
      text += `${i + 1}. ${hasImg} *!${name}*\n   ➤ ${preview}\n\n`;
    });
    
    text += `╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝`;
    
    return reply(text);
  }

  // #delcomando — Deletar um comando personalizado
  if (command === '#delcomando' || command === '#rmcmd') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Apenas admins e mods podem deletar comandos.');
    if (!args.length) return reply('❌ Use: #delcomando [nome]\nEx: #delcomando saudacao');
    
    const cmdName = args[0].toLowerCase();
    
    if (!customCmds[groupId] || !customCmds[groupId][cmdName]) {
      return reply(`❌ Comando *!${cmdName}* não encontrado.\nUse #vercomandos para ver a lista.`);
    }
    
    // Deletar imagem se existir
    if (customCmds[groupId][cmdName].imagePath) {
      try { fs.unlinkSync(customCmds[groupId][cmdName].imagePath); } catch {}
    }
    
    delete customCmds[groupId][cmdName];
    saveDB('customCmds', customCmds);
    
    return reply(`✅ Comando *!${cmdName}* deletado com sucesso!`);
  }

  // ===========================================================
  // EXECUTAR COMANDOS PERSONALIZADOS (verifica se existe)
  // ===========================================================
  
  if (isGroup && customCmds[groupId]) {
    const cmdName = command.substring(1); // Remove o # do início
    const cmd = customCmds[groupId][cmdName];
    
    if (cmd) {
      try {
        // Se tem imagem e texto
        if (cmd.imagePath && fs.existsSync(cmd.imagePath)) {
          const imgBuffer = fs.readFileSync(cmd.imagePath);
          await sock.sendMessage(groupId, {
            image: imgBuffer,
            caption: cmd.text || ''
          }, { quoted: message });
        } else if (cmd.text) {
          // Só texto
          await reply(cmd.text);
        }
        return;
      } catch (err) {
        console.log('[CMD PERSONALIZADO] Erro:', err.message);
        logBotError('custom_cmd_exec', err);
        return reply('❌ Erro ao executar o comando personalizado.');
      }
    }
  }

  // ===========================================================
  // COMANDO NAO ENCONTRADO (apenas se comecar com # ou /)
  // ===========================================================

  if (command.startsWith('#')) {
    return reply('Comando nao encontrado. Use #menu para ver os comandos disponiveis.');
  }
};

// ============================================================
// HANDLER DE EVENTOS DO GRUPO
// ============================================================

const handleGroupEvents = async (sock, events) => {
  if (!events['groups.update']) return;
};

// Checar horarios de abertura/fechamento automatico
const checkScheduledTimes = async (sock) => {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  for (const [groupId, settings] of Object.entries(groupSettings)) {
    // Abrir grupo
    if (settings.openAt === timeStr) {
      try {
        await sock.groupSettingUpdate(groupId, 'not_announcement');
        await sock.sendMessage(groupId, { text: 'O grupo abriu automaticamente! Bom dia a todos!' });
      } catch {}
    }
    // Fechar grupo
    if (settings.closeAt === timeStr) {
      try {
        await sock.groupSettingUpdate(groupId, 'announcement');
        await sock.sendMessage(groupId, { text: 'O grupo fechou automaticamente. Ate amanha!' });
      } catch {}
    }
    // Mensagens automaticas
    const msgs = autoMessages[groupId];
    if (msgs && msgs.length) {
      for (const m of msgs) {
        if (m.time === timeStr) {
          try { await sock.sendMessage(groupId, { text: m.text }); } catch {}
        }
      }
    }
  }
};

// Checar aniversarios do dia
const checkBirthdays = async (sock) => {
  const now = new Date();
  const day = now.getDate();
  const month = now.getMonth() + 1;
  const hour = now.getHours();
  if (hour !== 9) return; // Enviar as 9h

  for (const [groupId, members] of Object.entries(birthdays)) {
    for (const [userId, b] of Object.entries(members)) {
      if (b.day === day && b.month === month) {
        try {
          await sock.sendMessage(groupId, {
            text: `Hoje e aniversario de @${userId.split('@')[0]}!\n\nParabens, ${b.name}! Que seu dia seja especial!`,
            mentions: [userId],
          });
        } catch {}
      }
    }
  }
};

// ============================================================
// CONECTAR BOT
// ============================================================

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

const clearSession = () => {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('[SignaBot] Sessao removida com sucesso.');
    }
  } catch (e) { console.log('[SignaBot] Erro ao remover sessao: ' + e.message); }
};

let fatal405Count = 0;
let reconnectAttempts = 0;

const connectBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: ['SignaBot', 'Safari', '604.1'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 3000,
    maxMsgRetryCount: 3,
    emitOwnEvents: false,
    fireInitQueries: true,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // Agendamentos - verificar a cada 1 minuto
  const scheduleInterval = setInterval(() => checkScheduledTimes(sock), 60000);
  const birthdayInterval = setInterval(() => checkBirthdays(sock), 3600000);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      fatal405Count = 0;
      console.log('\n==============================');
      console.log('  Escaneie o QR Code abaixo   ');
      console.log('==============================\n');
      qrcode.generate(qr, { small: true });
      console.log('\n==============================\n');
    }

    if (connection === 'close') {
      clearInterval(scheduleInterval);
      clearInterval(birthdayInterval);

      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode : 0;

      console.log('[SignaBot] Conexao fechada. Codigo: ' + statusCode);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 440) {
        console.log('[SignaBot] Sessao encerrada. Limpando e gerando novo QR em 10s...');
        clearSession();
        reconnectAttempts = 0;
        fatal405Count = 0;
        setTimeout(() => connectBot(), 10000);
        return;
      }

      if (statusCode === 405 || statusCode === 403) {
        fatal405Count++;
        if (fatal405Count >= 3) {
          console.log('[SignaBot] IP bloqueado temporariamente. Aguardando 10 minutos...');
          fatal405Count = 0;
          setTimeout(() => connectBot(), 10 * 60 * 1000);
        } else {
          const delay = fatal405Count * 60000;
          console.log(`[SignaBot] Erro 405 (#${fatal405Count}). Aguardando ${delay / 1000}s...`);
          setTimeout(() => connectBot(), delay);
        }
        return;
      }

      const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
      reconnectAttempts++;
      console.log(`[SignaBot] Tentativa ${reconnectAttempts} — reconectando em ${delay / 1000}s...`);
      setTimeout(() => connectBot(), delay);

    } else if (connection === 'open') {
      reconnectAttempts = 0;
      fatal405Count = 0;
      console.log('[SignaBot] Conectado com sucesso!');
      console.log('[SignaBot] Numero: ' + sock.user.id.split(':')[0]);
    } else if (connection === 'connecting') {
      console.log('[SignaBot] Conectando ao WhatsApp...');
    }
  });

  // ============================================================
  // EVENTOS DE MENSAGEM
  // ============================================================

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        if (!message.message) continue;
        if (message.key.fromMe) continue;

        const groupId = message.key.remoteJid;
        const sender = message.key.participant || message.key.remoteJid;
        const isGroup = groupId.endsWith('@g.us');

        // Ignorar lista negra
        if (blacklist[sender]) {
          if (isGroup) {
            try { await sock.groupParticipantsUpdate(groupId, [sender], 'remove'); } catch {}
          }
          continue;
        }

        // Registrar atividade
        if (isGroup) logActivity(groupId, sender);

        // Verificar se membro esta mutado
        if (isGroup && muted[groupId]?.includes(sender)) {
          try {
            await sock.sendMessage(groupId, { delete: message.key });
          } catch {}
          continue;
        }

        const settings = isGroup ? getGroupSettings(groupId) : {};

        // ========== INICIAR TESTE GRÁTIS AUTOMATICAMENTE ==========
        // Só ativa se o grupo E o número do remetente nunca tiveram trial ou assinatura antes
        if (isGroup && !subscriptions[groupId] && !blacklist[sender]) {
          const senderNum = sender.split('@')[0];
          if (!groupOrNumberHasHistory(groupId, senderNum)) {
            subscriptions[groupId] = {
              type: 'trial',
              activatedAt: Date.now(),
              expiresAt: Date.now() + (10 * 60 * 1000), // 10 minutos
              notified: false
            };
            saveDB('subscriptions', subscriptions);
            // Registrar no histórico para impedir nova ativação
            markGroupHistory(groupId, 'trial', senderNum);
            
            await sock.sendMessage(groupId, {
              text: `🎉 *Teste Grátis Ativado!*\n\n⏰ Duração: 10 minutos\n\nApós o teste, o bot será bloqueado até que o dono ative a assinatura com o comando:\n!ativar [30|60] dias\n\nContato do dono:\nwa.me/${OWNER_NUMBER}`,
            });
          }
        }

        // Obter texto da mensagem
        const msgType = Object.keys(message.message)[0];
        let body = '';

        if (msgType === 'conversation') {
          body = message.message.conversation;
        } else if (msgType === 'extendedTextMessage') {
          body = message.message.extendedTextMessage.text;
        } else if (msgType === 'imageMessage') {
          body = message.message.imageMessage.caption || '';
        } else if (msgType === 'videoMessage') {
          body = message.message.videoMessage.caption || '';
        } else if (msgType === 'viewOnceMessage') {
          // Revelar view-once se ativado
          if (isGroup && settings.antiViewOnce) {
            try {
              const inner = message.message.viewOnceMessage.message;
              const innerType = Object.keys(inner)[0];
              const innerMsg = inner[innerType];
              const mediaType = innerType === 'imageMessage' ? 'image' : 'video';
              const buffer = await downloadMedia(innerMsg, mediaType);
              if (buffer) {
                await sock.sendMessage(groupId, {
                  [mediaType]: buffer,
                  caption: `Mensagem visualizacao unica de @${sender.split('@')[0]} revelada:`,
                }, { mentions: [sender] });
              }
            } catch {}
          }
          continue;
        }

        // ANTILINK
        if (isGroup && settings.antilink && body) {
          const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
          const urls = body.match(urlRegex);
          if (urls) {
            const allowed = settings.antilinkAllow || ['instagram.com', 'youtube.com', 'youtu.be', 'tiktok.com'];
            const hasBlocked = urls.some(url => !allowed.some(a => url.includes(a)));
            if (hasBlocked) {
              const isAdminSender = await isAdmin(sock, groupId, sender);
              if (!isAdminSender && !isOwner(sender)) {
                try { await sock.sendMessage(groupId, { delete: message.key }); } catch {}
                await sock.sendMessage(groupId, {
                  text: `@${sender.split('@')[0]}, links nao sao permitidos neste grupo!`,
                  mentions: [sender],
                });

                // Avisar se mandar link pro bot no privado
                continue;
              }
            }

            // Auto-baixar links de YouTube/TikTok/Instagram
            if (settings.autoBaixar) {
              for (const url of urls) {
                if (url.includes('youtu')) {
                  try {
                    let audioUrl = null;
                    const ytApis = [
                      async () => { const { data } = await axios.get(`https://api.xteam.xyz/ytdl?url=${encodeURIComponent(url)}&type=audio`, { timeout: 25000 }); return data?.url || null; },
                      async () => { const { data } = await axios.get(`https://api.siputzx.my.id/api/d/ytmp3?url=${encodeURIComponent(url)}`, { timeout: 25000 }); return data?.data?.url || data?.url || null; },
                    ];
                    for (const fn of ytApis) { try { audioUrl = await fn(); if (audioUrl) break; } catch {} }
                    if (audioUrl) {
                      const audioResp = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 60000 });
                      await sock.sendMessage(groupId, { audio: Buffer.from(audioResp.data), mimetype: 'audio/mpeg', ptt: false }, { quoted: message });
                    }
                  } catch {}
                }
                if (url.includes('tiktok')) {
                  try {
                    let videoUrl = null;
                    const ttApis = [
                      async () => { const { data } = await axios.get(`https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`, { timeout: 15000 }); return data?.video?.noWatermark || data?.video?.no_wm || null; },
                      async () => { const { data } = await axios.get(`https://api.tikwm.com/api/?url=${encodeURIComponent(url)}`, { timeout: 15000 }); return data?.data?.play || null; },
                    ];
                    for (const fn of ttApis) { try { videoUrl = await fn(); if (videoUrl) break; } catch {} }
                    if (videoUrl) {
                      const resp = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 60000 });
                      await sock.sendMessage(groupId, { video: Buffer.from(resp.data) }, { quoted: message });
                    }
                  } catch {}
                }
                if (url.includes('instagram.com')) {
                  try {
                    let mediaUrl = null;
                    let isVideo = false;
                    const igApis = [
                      async () => { const { data } = await axios.get(`https://api.xteam.xyz/igdl?url=${encodeURIComponent(url)}`, { timeout: 20000 }); return data?.url ? { mediaUrl: data.url, isVideo: data.type === 'video' } : null; },
                      async () => { const { data } = await axios.get(`https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(url)}`, { timeout: 20000 }); const link = data?.data?.[0]?.url || data?.url; return link ? { mediaUrl: link, isVideo: link.includes('.mp4') } : null; },
                    ];
                    for (const fn of igApis) { try { const r = await fn(); if (r?.mediaUrl) { mediaUrl = r.mediaUrl; isVideo = r.isVideo; break; } } catch {} }
                    if (mediaUrl) {
                      const resp = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 60000 });
                      const buf = Buffer.from(resp.data);
                      if (isVideo) await sock.sendMessage(groupId, { video: buf, caption: 'Instagram' }, { quoted: message });
                      else await sock.sendMessage(groupId, { image: buf, caption: 'Instagram' }, { quoted: message });
                    }
                  } catch {}
                }
              }
            }
          }
        }

        // FILTRO DE PALAVROES
        if (isGroup && settings.antiPalavra && body && settings.palavroes?.length) {
          const lower = body.toLowerCase();
          const found = settings.palavroes.find(p => lower.includes(p));
          if (found) {
            const isAdminSender = await isAdmin(sock, groupId, sender);
            if (!isAdminSender && !isOwner(sender)) {
              try { await sock.sendMessage(groupId, { delete: message.key }); } catch {}
              await sock.sendMessage(groupId, {
                text: `@${sender.split('@')[0]}, palavroes nao sao permitidos!`,
                mentions: [sender],
              });
              continue;
            }
          }
        }

        // ANTI VENDAS - Detecta mensagens de venda e deleta
        if (isGroup && settings.antiVendas && body) {
          // Padrões de detecção de vendas
          const vendasPatterns = [
            /R\$\s*\d+/i,                          // R$ seguido de número (R$10, R$ 50, etc.)
            /\d+[.,]\d{2}\s*(reais|real)/i,         // 10,00 reais / 50.00 real
            /\d+\s*(reais|real)/i,                   // 10 reais / 50 real
            /vendo\b/i,                              // "vendo"
            /vende-se/i,                             // "vende-se"
            /à venda/i,                              // "à venda"
            /a venda/i,                              // "a venda"
            /compre\s+(já|agora|aqui)/i,             // "compre já/agora/aqui"
            /promoção/i,                             // "promoção"
            /promo[çc][aã]o/i,                       // "promoçao" (sem acento)
            /oferta\s+(imperdível|especial|relâmpago)/i, // "oferta imperdível/especial"
            /por\s+apenas\s+R?\$?\s*\d+/i,           // "por apenas R$10"
            /pix\s+.*\d+/i,                          // "pix" seguido de valor
            /entrega\s+(grátis|gratuita|gratis)/i,   // "entrega grátis"
            /frete\s+(grátis|gratuita|gratis|free)/i,// "frete grátis"
            /link\s+(na\s+)?bio/i,                   // "link na bio"
            /chama\s+(no\s+)?(pv|privado|inbox|dm)/i,// "chama no pv/privado"
            /interessados?\s+(chama|inbox|pv|dm|privado)/i, // "interessados chama"
            /vendas?\s+(pelo|por|via|no)\s+(whatsapp|whats|zap|insta)/i, // "vendas pelo whatsapp"
            /tabela\s+de\s+pre[çc]os?/i,             // "tabela de preços"
            /valores?\s+(no|pelo|via)\s+(pv|privado|inbox|dm)/i, // "valores no pv"
          ];
          
          const isVenda = vendasPatterns.some(pattern => pattern.test(body));
          
          if (isVenda) {
            const isAdminSender = await isAdmin(sock, groupId, sender);
            if (!isAdminSender && !isOwner(sender)) {
              // Deletar a mensagem de venda
              try { await sock.sendMessage(groupId, { delete: message.key }); } catch {}
              
              // Buscar os admins do grupo para mencionar
              try {
                const meta = await sock.groupMetadata(groupId);
                const admins = meta.participants.filter(p => p.admin);
                const adminMentions = admins.map(a => a.id);
                const adminTags = admins.map(a => `@${a.id.split('@')[0]}`).join(' ');
                
                await sock.sendMessage(groupId, {
                  text: `🚫 *ANTI VENDAS*\n\n⚠️ O usuário @${sender.split('@')[0]} enviou uma mensagem de venda e foi deletada!\n\n👮 Admins: ${adminTags}`,
                  mentions: [sender, ...adminMentions],
                });
              } catch {
                await sock.sendMessage(groupId, {
                  text: `🚫 *ANTI VENDAS*\n\n⚠️ O usuário @${sender.split('@')[0]} enviou uma mensagem de venda e foi deletada!`,
                  mentions: [sender],
                });
              }
              continue;
            }
          }
        }

        // SO-ADM
        if (isGroup && settings.soAdm && body) {
          const isAdminSender = await isAdmin(sock, groupId, sender);
          if (!isAdminSender && !isOwner(sender) && !hasCargo(groupId, sender, 'admin', 'mod', 'aux')) {
            try { await sock.sendMessage(groupId, { delete: message.key }); } catch {}
            continue;
          }
        }

        // VERIFICAR AFK (se mencionar alguem que esta ausente)
        if (isGroup && body) {
          const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          for (const uid of mentioned) {
            if (afkList[uid]) {
              const afk = afkList[uid];
              await sock.sendMessage(groupId, {
                text: `@${uid.split('@')[0]} esta ausente: "${afk.msg}" (ha ${formatTime(Date.now() - afk.time)})`,
                mentions: [uid],
              });
            }
          }
          // Se o proprio usuario que estava ausente mandou mensagem, remover AFK
          if (afkList[sender]) {
            const afk = afkList[sender];
            delete afkList[sender];
            saveDB('afkList', afkList);
            await sock.sendMessage(groupId, {
              text: `@${sender.split('@')[0]} voltou da ausencia! (ficou ausente por ${formatTime(Date.now() - afk.time)})`,
              mentions: [sender],
            });
          }
        }

        // ===========================================================
        // MENSAGEM PRIVADA — DETECTAR ADMIN E CONFIGURAR GRUPOS
        // ===========================================================
        if (!isGroup) {
          const privateSender = sender;
          const privateReply = (text) => sock.sendMessage(groupId, { text }, { quoted: message });
          const ownerPrivate = isOwner(privateSender);
          
          // Verificar se o usuário está em um fluxo de configuração
          if (!privateConfig[privateSender]) {
            privateConfig[privateSender] = { step: 'idle', selectedGroup: null };
          }
          
          const pConfig = privateConfig[privateSender];

          // ─────────────────────────────────────────────────────
          // HELPER: Gera o menu principal de configuração do grupo
          // ─────────────────────────────────────────────────────
          const buildConfigMenu = (gId, gName) => {
            const s = getGroupSettings(gId);
            const sub = checkSubscription(gId);
            const subInfo = sub.active
              ? `✅ Ativa | Expira em: ${formatTime(sub.expiresAt - Date.now())}`
              : '❌ Inativa';
            
            // Contar comandos personalizados
            const cmdCount = customCmds[gId] ? Object.keys(customCmds[gId]).length : 0;
            
            // Contar mensagens agendadas
            const schedCount = autoMessages[gId] ? Object.keys(autoMessages[gId]).length : 0;

            let menu = `
╔══════════════════════════╗
  ⚙️ *${gName}*
╚══════════════════════════╝

📊 *Assinatura:* ${subInfo}

━━━ *FUNÇÕES* ━━━━━━━━━━━━
1️⃣ Antilink: ${s.antilink ? '✅' : '❌'}
2️⃣ Bem-vindo: ${s.welcome ? '✅' : '❌'}
3️⃣ Anti Palavrão: ${s.antiPalavra ? '✅' : '❌'}
4️⃣ Anti Vendas: ${s.antiVendas ? '✅' : '❌'}
5️⃣ Anti Call: ${s.anticall ? '✅' : '❌'}
6️⃣ Só Admin: ${s.soAdm ? '✅' : '❌'}
7️⃣ Anti View Once: ${s.antiViewOnce ? '✅' : '❌'}
8️⃣ Auto Baixar: ${s.autoBaixar ? '✅' : '❌'}
9️⃣ Anti Spam: ${s.antiSpam ? '✅' : '❌'}
🔟 Anti Imagem: ${s.antiImg ? '✅' : '❌'}

━━━ *TEXTOS* ━━━━━━━━━━━━━
➤ *bemvindo* [msg] — Texto de boas-vindas
   Atual: ${s.welcomeMsg ? s.welcomeMsg.substring(0, 50) + '...' : 'Padrão'}
➤ *saida* [msg] — Texto de saída
   Atual: ${s.leaveMsg ? s.leaveMsg.substring(0, 50) + '...' : 'Padrão'}
➤ *regras* [texto] — Definir regras
   Atual: ${rules[gId] ? 'Definido' : 'Não definido'}

━━━ *HORÁRIOS* ━━━━━━━━━━━
➤ *abrir* HH:MM — Abrir grupo
   Atual: ${s.openAt || 'Não definido'}
➤ *fechar* HH:MM — Fechar grupo
   Atual: ${s.closeAt || 'Não definido'}

━━━ *COMANDOS PERSONALIZADOS* ━━━
📝 Total: ${cmdCount} comando(s)
➤ *vercmd* — Ver comandos do grupo
➤ *addcmd* [nome] [texto] — Criar comando
➤ *delcmd* [nome] — Deletar comando

━━━ *MENSAGENS AGENDADAS* ━━━━
📅 Total: ${schedCount} agendamento(s)
➤ *veragenda* — Ver agendamentos
➤ *agenda* HH:MM [texto] — Agendar msg
➤ *delagenda* [id] — Remover agendamento

━━━ *NAVEGAÇÃO* ━━━━━━━━━━`;

            if (ownerPrivate) {
              menu += `
➤ *plano* — Gerenciar assinatura
➤ *logs* — Ver logs de erros do bot
➤ *stats* — Estatísticas do grupo`;
            }

            menu += `
➤ *trocar* — Mudar de grupo
➤ *menu* — Exibir este menu novamente
➤ *sair* — Encerrar configuração

╔══════════════════════════╗
        ⚡ *SignaBOT* ⚡
╚══════════════════════════╝`;
            return menu;
          };
          
          // ─────────────────────────────────────────────────────
          // ETAPA: Seleção de grupo (resposta numérica)
          // ─────────────────────────────────────────────────────
          if (pConfig.step === 'awaiting_group_selection' && /^\d+$/.test(body.trim())) {
            const idx = parseInt(body.trim()) - 1;
            const groups = pConfig.adminGroups || [];
            
            if (idx >= 0 && idx < groups.length) {
              const selectedGroup = groups[idx];
              pConfig.step = 'configuring';
              pConfig.selectedGroup = selectedGroup.id;
              pConfig.selectedGroupName = selectedGroup.name;
              saveDB('privateConfig', privateConfig);
              
              logBotAction('private_config', `${privateSender} selecionou grupo ${selectedGroup.name}`);
              await privateReply(buildConfigMenu(selectedGroup.id, selectedGroup.name));
              continue;
            } else {
              await privateReply('Opcao invalida. Envie o numero correspondente ao grupo.');
              continue;
            }
          }
          
          // ─────────────────────────────────────────────────────
          // ETAPA: Modo de configuração ativo
          // ─────────────────────────────────────────────────────
          if (pConfig.step === 'configuring' && pConfig.selectedGroup) {
            const input = body.trim().toLowerCase();
            const rawInput = body.trim(); // Preservar formatação original
            const selectedGroupId = pConfig.selectedGroup;
            const selectedGroupName = pConfig.selectedGroupName || 'Grupo';
            const settings = getGroupSettings(selectedGroupId);
            
            // === SAIR ===
            if (input === 'sair' || input === 'exit') {
              pConfig.step = 'idle';
              pConfig.selectedGroup = null;
              saveDB('privateConfig', privateConfig);
              await privateReply('Configuracao encerrada! Envie qualquer mensagem para iniciar novamente.');
              continue;
            }
            
            // === MENU (reexibir) ===
            if (input === 'menu') {
              await privateReply(buildConfigMenu(selectedGroupId, selectedGroupName));
              continue;
            }
            
            // === TROCAR DE GRUPO ===
            if (input === 'trocar' || input === 'mudar') {
              pConfig.step = 'idle';
              pConfig.selectedGroup = null;
              saveDB('privateConfig', privateConfig);
              // Cai no fluxo de detecção de admin abaixo
            }
            
            // === TOGGLE FUNÇÕES (1-10) ===
            else {
              const toggleMap = {
                '1': { key: 'antilink', name: 'Antilink' },
                '2': { key: 'welcome', name: 'Bem-vindo' },
                '3': { key: 'antiPalavra', name: 'Anti Palavrao' },
                '4': { key: 'antiVendas', name: 'Anti Vendas' },
                '5': { key: 'anticall', name: 'Anti Call' },
                '6': { key: 'soAdm', name: 'So Admin' },
                '7': { key: 'antiViewOnce', name: 'Anti View Once' },
                '8': { key: 'autoBaixar', name: 'Auto Baixar' },
                '9': { key: 'antiSpam', name: 'Anti Spam' },
                '10': { key: 'antiImg', name: 'Anti Imagem' },
              };
              
              if (toggleMap[input]) {
                const opt = toggleMap[input];
                settings[opt.key] = !settings[opt.key];
                saveSettings();
                logBotAction('toggle_setting', `${opt.name} = ${settings[opt.key]} em ${selectedGroupName}`);
                
                const status = settings[opt.key] ? 'ATIVADO' : 'DESATIVADO';
                await privateReply(`${opt.name}: ${status}\n\nEnvie outro numero ou *menu* para ver opcoes.`);
                continue;
              }
              
              // === HORÁRIO DE ABERTURA ===
              if (input.startsWith('abrir ')) {
                const time = input.replace('abrir ', '').trim();
                if (/^\d{2}:\d{2}$/.test(time)) {
                  settings.openAt = time;
                  saveSettings();
                  logBotAction('set_open', `${selectedGroupName} abrir as ${time}`);
                  await privateReply(`Grupo vai abrir automaticamente as ${time}`);
                  continue;
                }
                await privateReply('Formato invalido. Use: abrir HH:MM (ex: abrir 08:00)');
                continue;
              }
              
              // === HORÁRIO DE FECHAMENTO ===
              if (input.startsWith('fechar ')) {
                const time = input.replace('fechar ', '').trim();
                if (/^\d{2}:\d{2}$/.test(time)) {
                  settings.closeAt = time;
                  saveSettings();
                  logBotAction('set_close', `${selectedGroupName} fechar as ${time}`);
                  await privateReply(`Grupo vai fechar automaticamente as ${time}`);
                  continue;
                }
                await privateReply('Formato invalido. Use: fechar HH:MM (ex: fechar 22:00)');
                continue;
              }
              
              // === MENSAGEM DE BOAS-VINDAS ===
              if (input.startsWith('bemvindo ') || input.startsWith('bemvindo\n')) {
                const msg = rawInput.substring(rawInput.indexOf(' ') + 1); // Preservar formato
                settings.welcomeMsg = msg;
                saveSettings();
                logBotAction('set_welcome', `Boas-vindas em ${selectedGroupName}`);
                await privateReply(`Mensagem de boas-vindas definida:\n\n${msg}\n\n*Variaveis disponiveis:*\n@user — Nome do membro\n@group — Nome do grupo\n@desc — Descricao do grupo`);
                continue;
              }
              
              // === MENSAGEM DE SAÍDA ===
              if (input.startsWith('saida ') || input.startsWith('saida\n')) {
                const msg = rawInput.substring(rawInput.indexOf(' ') + 1);
                settings.leaveMsg = msg;
                saveSettings();
                logBotAction('set_leave', `Saida em ${selectedGroupName}`);
                await privateReply(`Mensagem de saida definida:\n\n${msg}`);
                continue;
              }
              
              // === DEFINIR REGRAS ===
              if (input.startsWith('regras ') || input.startsWith('regras\n')) {
                const msg = rawInput.substring(rawInput.indexOf(' ') + 1);
                rules[selectedGroupId] = msg;
                saveDB('rules', rules);
                logBotAction('set_rules', `Regras em ${selectedGroupName}`);
                await privateReply(`Regras do grupo definidas:\n\n${msg}`);
                continue;
              }
              
              // === VER COMANDOS PERSONALIZADOS ===
              if (input === 'vercmd' || input === 'vercomandos') {
                const cmds = customCmds[selectedGroupId];
                if (!cmds || !Object.keys(cmds).length) {
                  await privateReply('Nenhum comando personalizado neste grupo.\n\nUse: addcmd [nome] [texto]');
                  continue;
                }
                let text = `*Comandos personalizados — ${selectedGroupName}:*\n\n`;
                Object.entries(cmds).forEach(([name, cmd], i) => {
                  const hasImg = cmd.imagePath ? '[IMG]' : '';
                  const preview = cmd.text ? (cmd.text.length > 40 ? cmd.text.substring(0, 40) + '...' : cmd.text) : '(somente imagem)';
                  const creator = cmd.creator ? cmd.creator.split('@')[0] : 'N/A';
                  const date = cmd.createdAt ? new Date(cmd.createdAt).toLocaleDateString('pt-BR') : 'N/A';
                  text += `${i + 1}. *!${name}* ${hasImg}\n   ${preview}\n   Criado por: ${creator} em ${date}\n\n`;
                });
                text += 'Para deletar: delcmd [nome]';
                await privateReply(text);
                continue;
              }
              
              // === CRIAR COMANDO PERSONALIZADO (pelo privado) ===
              if (input.startsWith('addcmd ')) {
                const parts = rawInput.substring(7).split(/\s+/);
                const cmdName = parts[0]?.toLowerCase();
                const cmdText = parts.slice(1).join(' ');
                if (!cmdName || !cmdText) {
                  await privateReply('Use: addcmd [nome] [texto]\nEx: addcmd saudacao Ola pessoal!');
                  continue;
                }
                if (!customCmds[selectedGroupId]) customCmds[selectedGroupId] = {};
                customCmds[selectedGroupId][cmdName] = {
                  text: cmdText,
                  imagePath: null,
                  creator: privateSender,
                  createdAt: Date.now()
                };
                saveDB('customCmds', customCmds);
                logBotAction('addcmd_private', `!${cmdName} em ${selectedGroupName}`);
                await privateReply(`Comando *!${cmdName}* criado!\nTexto: ${cmdText}\n\nPara imagem, crie pelo grupo com !comando`);
                continue;
              }
              
              // === DELETAR COMANDO PERSONALIZADO ===
              if (input.startsWith('delcmd ')) {
                const cmdName = input.replace('delcmd ', '').trim().toLowerCase();
                if (!customCmds[selectedGroupId] || !customCmds[selectedGroupId][cmdName]) {
                  await privateReply(`Comando *!${cmdName}* nao encontrado.\nUse *vercmd* para ver a lista.`);
                  continue;
                }
                if (customCmds[selectedGroupId][cmdName].imagePath) {
                  try { fs.unlinkSync(customCmds[selectedGroupId][cmdName].imagePath); } catch {}
                }
                delete customCmds[selectedGroupId][cmdName];
                saveDB('customCmds', customCmds);
                logBotAction('delcmd_private', `!${cmdName} em ${selectedGroupName}`);
                await privateReply(`Comando *!${cmdName}* deletado!`);
                continue;
              }
              
              // === VER AGENDAMENTOS ===
              if (input === 'veragenda' || input === 'agendamentos') {
                const scheds = autoMessages[selectedGroupId];
                if (!scheds || !Object.keys(scheds).length) {
                  await privateReply('Nenhuma mensagem agendada neste grupo.\n\nUse: agenda HH:MM [texto]');
                  continue;
                }
                let text = `*Mensagens agendadas — ${selectedGroupName}:*\n\n`;
                Object.entries(scheds).forEach(([id, sched], i) => {
                  const preview = sched.text ? (sched.text.length > 50 ? sched.text.substring(0, 50) + '...' : sched.text) : 'Sem texto';
                  text += `*${i + 1}.* ID: ${id}\n   Horario: ${sched.time}\n   Dias: ${sched.days || 'Todos'}\n   Texto: ${preview}\n   Status: ${sched.active !== false ? 'Ativo' : 'Pausado'}\n\n`;
                });
                text += 'Para remover: delagenda [id]';
                await privateReply(text);
                continue;
              }
              
              // === AGENDAR MENSAGEM ===
              if (input.startsWith('agenda ')) {
                const parts = rawInput.substring(7).trim();
                const timeMatch = parts.match(/^(\d{2}:\d{2})\s+(.+)/s);
                if (!timeMatch) {
                  await privateReply('Use: agenda HH:MM [texto]\nEx: agenda 08:00 Bom dia pessoal!\n\nOpcoes avancadas:\nagenda 08:00 seg,qua,sex Bom dia!');
                  continue;
                }
                const time = timeMatch[1];
                let msgContent = timeMatch[2];
                let days = 'todos';
                
                // Verificar se tem dias específicos
                const daysMatch = msgContent.match(/^(seg|ter|qua|qui|sex|sab|dom)(,(seg|ter|qua|qui|sex|sab|dom))*\s+/i);
                if (daysMatch) {
                  days = daysMatch[0].trim().toLowerCase();
                  msgContent = msgContent.substring(daysMatch[0].length);
                }
                
                const schedId = 'sch_' + Date.now().toString(36);
                if (!autoMessages[selectedGroupId]) autoMessages[selectedGroupId] = {};
                autoMessages[selectedGroupId][schedId] = {
                  time,
                  text: msgContent,
                  days,
                  active: true,
                  creator: privateSender,
                  createdAt: Date.now()
                };
                saveDB('autoMessages', autoMessages);
                logBotAction('schedule_private', `${schedId} as ${time} em ${selectedGroupName}`);
                await privateReply(`Mensagem agendada!\n\nID: ${schedId}\nHorario: ${time}\nDias: ${days}\nTexto: ${msgContent}`);
                continue;
              }
              
              // === REMOVER AGENDAMENTO ===
              if (input.startsWith('delagenda ')) {
                const schedId = input.replace('delagenda ', '').trim();
                if (!autoMessages[selectedGroupId] || !autoMessages[selectedGroupId][schedId]) {
                  await privateReply(`Agendamento *${schedId}* nao encontrado.\nUse *veragenda* para ver a lista.`);
                  continue;
                }
                delete autoMessages[selectedGroupId][schedId];
                saveDB('autoMessages', autoMessages);
                logBotAction('del_schedule', `${schedId} em ${selectedGroupName}`);
                await privateReply(`Agendamento *${schedId}* removido!`);
                continue;
              }
              
              // ============================================
              // DONO: GERENCIAR PLANO / ASSINATURA
              // ============================================
              if (input === 'plano' && ownerPrivate) {
                const sub = checkSubscription(selectedGroupId);
                const subData = subscriptions[selectedGroupId];
                let text = `
╔══════════════════════════╗
  *ASSINATURA — ${selectedGroupName}*
╚══════════════════════════╝

`;
                if (sub.active) {
                  const expDate = new Date(sub.expiresAt).toLocaleDateString('pt-BR');
                  const expTime = new Date(sub.expiresAt).toLocaleTimeString('pt-BR');
                  const restante = formatTime(sub.expiresAt - Date.now());
                  text += `Status: ATIVA\n`;
                  text += `Tipo: ${subData?.type || 'premium'}\n`;
                  text += `Expira em: ${expDate} as ${expTime}\n`;
                  text += `Tempo restante: ${restante}\n`;
                  text += `Ativado por: ${subData?.activatedBy?.split('@')[0] || 'N/A'}\n`;
                } else {
                  text += `Status: INATIVA\n`;
                  text += `Motivo: ${sub.reason || 'Sem assinatura'}\n`;
                }
                
                text += `
━━━ *ACOES* ━━━━━━━━━━━━━━
➤ *ativar [dias]* — Ativar plano
   Ex: ativar 30
➤ *ativar trial* — Ativar teste gratis (3 dias)
➤ *cancelar* — Cancelar assinatura
➤ *renovar [dias]* — Adicionar dias
➤ *menu* — Voltar ao menu principal`;
                
                await privateReply(text);
                continue;
              }
              
              // === DONO: ATIVAR PLANO ===
              if (input.startsWith('ativar ') && ownerPrivate) {
                const param = input.replace('ativar ', '').trim();
                
                if (param === 'trial') {
                  // Ativar trial de 3 dias
                  subscriptions[selectedGroupId] = {
                    type: 'trial',
                    expiresAt: Date.now() + (3 * 86400000),
                    activatedBy: privateSender,
                    activatedAt: Date.now()
                  };
                  saveDB('subscriptions', subscriptions);
                  markGroupHistory(selectedGroupId, 'trial', privateSender.split('@')[0]);
                  logBotAction('activate_trial', `Trial ativado em ${selectedGroupName} por ${privateSender.split('@')[0]}`);
                  await privateReply(`Trial de 3 dias ativado para *${selectedGroupName}*!\nExpira em: ${new Date(subscriptions[selectedGroupId].expiresAt).toLocaleDateString('pt-BR')}`);
                  continue;
                }
                
                const dias = parseInt(param);
                if (!dias || dias < 1 || dias > 365) {
                  await privateReply('Use: ativar [dias] (1-365)\nEx: ativar 30\nOu: ativar trial');
                  continue;
                }
                
                subscriptions[selectedGroupId] = {
                  type: 'premium',
                  expiresAt: Date.now() + (dias * 86400000),
                  activatedBy: privateSender,
                  activatedAt: Date.now()
                };
                saveDB('subscriptions', subscriptions);
                markGroupHistory(selectedGroupId, 'paid', privateSender.split('@')[0]);
                logBotAction('activate_plan', `${dias} dias em ${selectedGroupName} por ${privateSender.split('@')[0]}`);
                await privateReply(`Plano de *${dias} dias* ativado para *${selectedGroupName}*!\nExpira em: ${new Date(subscriptions[selectedGroupId].expiresAt).toLocaleDateString('pt-BR')}`);
                continue;
              }
              
              // === DONO: CANCELAR PLANO ===
              if (input === 'cancelar' && ownerPrivate) {
                if (!subscriptions[selectedGroupId]) {
                  await privateReply('Este grupo nao possui assinatura ativa.');
                  continue;
                }
                markGroupHistory(selectedGroupId, subscriptions[selectedGroupId].type || 'paid', privateSender.split('@')[0]);
                delete subscriptions[selectedGroupId];
                saveDB('subscriptions', subscriptions);
                logBotAction('cancel_plan', `Cancelado em ${selectedGroupName} por ${privateSender.split('@')[0]}`);
                await privateReply(`Assinatura de *${selectedGroupName}* foi CANCELADA.`);
                continue;
              }
              
              // === DONO: RENOVAR PLANO ===
              if (input.startsWith('renovar ') && ownerPrivate) {
                const dias = parseInt(input.replace('renovar ', '').trim());
                if (!dias || dias < 1 || dias > 365) {
                  await privateReply('Use: renovar [dias] (1-365)\nEx: renovar 30');
                  continue;
                }
                
                const currentSub = subscriptions[selectedGroupId];
                const baseTime = (currentSub && currentSub.expiresAt > Date.now()) ? currentSub.expiresAt : Date.now();
                
                subscriptions[selectedGroupId] = {
                  type: 'premium',
                  expiresAt: baseTime + (dias * 86400000),
                  activatedBy: privateSender,
                  activatedAt: Date.now(),
                  renewedFrom: currentSub?.expiresAt || null
                };
                saveDB('subscriptions', subscriptions);
                logBotAction('renew_plan', `+${dias} dias em ${selectedGroupName}`);
                
                const newExpire = new Date(subscriptions[selectedGroupId].expiresAt).toLocaleDateString('pt-BR');
                await privateReply(`*${dias} dias* adicionados a *${selectedGroupName}*!\nNova data de expiracao: ${newExpire}\nTempo total restante: ${formatTime(subscriptions[selectedGroupId].expiresAt - Date.now())}`);
                continue;
              }
              
              // ============================================
              // DONO: VER LOGS DE ERROS
              // ============================================
              if (input === 'logs' && ownerPrivate) {
                const errors = botLogs.errors || [];
                if (!errors.length) {
                  await privateReply('Nenhum erro registrado.\n\nEnvie *logs acoes* para ver acoes recentes.');
                  continue;
                }
                const last10 = errors.slice(-10).reverse();
                let text = `*LOGS DE ERROS (ultimos ${last10.length}):*\n\n`;
                last10.forEach((log, i) => {
                  const date = new Date(log.time).toLocaleString('pt-BR');
                  text += `${i + 1}. [${date}]\n   Contexto: ${log.context}\n   Erro: ${log.error}\n\n`;
                });
                text += '\nComandos:\n➤ *logs acoes* — Ver acoes recentes\n➤ *logs limpar* — Limpar todos os logs\n➤ *logs completo* — Ver todos os erros';
                await privateReply(text);
                continue;
              }
              
              if (input === 'logs acoes' && ownerPrivate) {
                const actions = botLogs.actions || [];
                if (!actions.length) {
                  await privateReply('Nenhuma acao registrada.');
                  continue;
                }
                const last15 = actions.slice(-15).reverse();
                let text = `*LOG DE ACOES (ultimas ${last15.length}):*\n\n`;
                last15.forEach((log, i) => {
                  const date = new Date(log.time).toLocaleString('pt-BR');
                  text += `${i + 1}. [${date}]\n   ${log.action}: ${log.details}\n\n`;
                });
                await privateReply(text);
                continue;
              }
              
              if (input === 'logs limpar' && ownerPrivate) {
                botLogs.errors = [];
                botLogs.actions = [];
                saveDB('botLogs', botLogs);
                await privateReply('Todos os logs foram limpos!');
                continue;
              }
              
              if (input === 'logs completo' && ownerPrivate) {
                const errors = botLogs.errors || [];
                if (!errors.length) {
                  await privateReply('Nenhum erro registrado.');
                  continue;
                }
                // Enviar em blocos para não exceder limite
                const chunks = [];
                let current = '*TODOS OS ERROS:*\n\n';
                errors.forEach((log, i) => {
                  const date = new Date(log.time).toLocaleString('pt-BR');
                  const entry = `${i + 1}. [${date}]\n   ${log.context}\n   ${log.error}\n   ${log.stack}\n\n`;
                  if (current.length + entry.length > 3500) {
                    chunks.push(current);
                    current = '';
                  }
                  current += entry;
                });
                if (current) chunks.push(current);
                for (const chunk of chunks) {
                  await privateReply(chunk);
                }
                continue;
              }
              
              // ============================================
              // DONO: ESTATÍSTICAS DO GRUPO
              // ============================================
              if (input === 'stats' && ownerPrivate) {
                const activity = userActivity[selectedGroupId] || {};
                const members = Object.keys(activity).length;
                let totalMsgs = 0;
                let topUsers = [];
                
                for (const [uid, data] of Object.entries(activity)) {
                  totalMsgs += data.messageCount || 0;
                  topUsers.push({ id: uid, count: data.messageCount || 0, last: data.lastActive || 0 });
                }
                topUsers.sort((a, b) => b.count - a.count);
                const top5 = topUsers.slice(0, 5);
                
                const sub = checkSubscription(selectedGroupId);
                const cmdsCount = customCmds[selectedGroupId] ? Object.keys(customCmds[selectedGroupId]).length : 0;
                const schedsCount = autoMessages[selectedGroupId] ? Object.keys(autoMessages[selectedGroupId]).length : 0;
                const warnsCount = warnings[selectedGroupId] ? Object.keys(warnings[selectedGroupId]).length : 0;
                
                let text = `
╔══════════════════════════╗
  *ESTATISTICAS — ${selectedGroupName}*
╚══════════════════════════╝

*Membros ativos:* ${members}
*Total de mensagens:* ${totalMsgs}
*Comandos personalizados:* ${cmdsCount}
*Agendamentos:* ${schedsCount}
*Membros com advertencia:* ${warnsCount}
*Assinatura:* ${sub.active ? 'Ativa' : 'Inativa'}

*Top 5 mais ativos:*
`;
                top5.forEach((u, i) => {
                  const num = u.id.split('@')[0];
                  const lastDate = u.last ? new Date(u.last).toLocaleDateString('pt-BR') : 'N/A';
                  text += `${i + 1}. ${num} — ${u.count} msgs (ultimo: ${lastDate})\n`;
                });
                
                if (!top5.length) text += 'Sem dados de atividade ainda.\n';
                
                await privateReply(text);
                continue;
              }
              
              // === VER EXPIRAÇÃO DO PLANO (para admins) ===
              if (input === 'expira' || input === 'vencimento' || input === 'assinatura') {
                const sub = checkSubscription(selectedGroupId);
                const subData = subscriptions[selectedGroupId];
                
                if (sub.active) {
                  const expDate = new Date(sub.expiresAt).toLocaleDateString('pt-BR');
                  const expTime = new Date(sub.expiresAt).toLocaleTimeString('pt-BR');
                  const restante = formatTime(sub.expiresAt - Date.now());
                  await privateReply(`*Assinatura — ${selectedGroupName}*\n\nStatus: ATIVA\nTipo: ${subData?.type || 'premium'}\nExpira em: ${expDate} as ${expTime}\nTempo restante: ${restante}\n\nPara renovar, entre em contato:\nwa.me/${OWNER_NUMBER}`);
                } else {
                  await privateReply(`*Assinatura — ${selectedGroupName}*\n\nStatus: INATIVA\n${sub.reason || 'Sem assinatura'}\n\nPara adquirir um plano:\nwa.me/${OWNER_NUMBER}`);
                }
                continue;
              }
              
              // === OPÇÃO NÃO RECONHECIDA ===
              const validInputs = ['1','2','3','4','5','6','7','8','9','10','menu','sair','exit','trocar','mudar','vercmd','vercomandos','veragenda','agendamentos','plano','logs','stats','expira','vencimento','assinatura','cancelar'];
              const startsValid = ['abrir ','fechar ','bemvindo ','saida ','regras ','addcmd ','delcmd ','delagenda ','agenda ','ativar ','renovar ','logs '];
              
              if (!validInputs.includes(input) && !startsValid.some(s => input.startsWith(s))) {
                await privateReply(`Opcao nao reconhecida.\n\nEnvie *menu* para ver todas as opcoes.\nOu envie um *numero* (1-10) para ativar/desativar funcoes.`);
                continue;
              }
            }
          }
          
          // ─────────────────────────────────────────────────────
          // ETAPA: Detecção de Admin e listagem de grupos
          // ─────────────────────────────────────────────────────
          if (pConfig.step === 'idle' || !pConfig.step) {
            try {
              // Buscar todos os grupos do bot
              const allGroups = await sock.groupFetchAllParticipating();
              const adminGroups = [];
              
              for (const [gId, group] of Object.entries(allGroups)) {
                const participant = group.participants.find(p => p.id === privateSender);
                if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
                  adminGroups.push({
                    id: gId,
                    name: group.subject,
                    role: participant.admin === 'superadmin' ? 'Criador' : 'Admin'
                  });
                }
              }
              
              // Também verificar cargos do bot
              for (const [gId, group] of Object.entries(allGroups)) {
                if (adminGroups.find(g => g.id === gId)) continue;
                if (cargos[gId] && cargos[gId][privateSender]) {
                  const cargo = cargos[gId][privateSender];
                  if (['admin', 'mod'].includes(cargo)) {
                    adminGroups.push({
                      id: gId,
                      name: group.subject,
                      role: `Cargo: ${cargo}`
                    });
                  }
                }
              }
              
              // ── DONO DO BOT: Mostrar TODOS os grupos + painel especial ──
              if (ownerPrivate) {
                const allGroupsList = Object.entries(allGroups).map(([gId, g]) => {
                  const sub = checkSubscription(gId);
                  const subStatus = sub.active ? 'Ativa' : 'Inativa';
                  const expira = sub.active ? formatTime(sub.expiresAt - Date.now()) : '-';
                  return {
                    id: gId,
                    name: g.subject,
                    role: 'Dono do Bot',
                    subStatus,
                    expira,
                    members: g.participants?.length || 0
                  };
                });
                
                if (allGroupsList.length) {
                  pConfig.step = 'awaiting_group_selection';
                  pConfig.adminGroups = allGroupsList;
                  saveDB('privateConfig', privateConfig);
                  
                  // Contar estatísticas gerais
                  const totalGrupos = allGroupsList.length;
                  const gruposAtivos = allGroupsList.filter(g => g.subStatus === 'Ativa').length;
                  const gruposInativos = totalGrupos - gruposAtivos;
                  const totalErros = (botLogs.errors || []).length;
                  
                  let text = `
╔══════════════════════════╗
  *PAINEL DO DONO — SignaBOT*
╚══════════════════════════╝

Ola, *${message.pushName || 'Dono'}*!

*RESUMO GERAL:*
Total de grupos: ${totalGrupos}
Assinaturas ativas: ${gruposAtivos}
Assinaturas inativas: ${gruposInativos}
Erros registrados: ${totalErros}

━━━ *GRUPOS* ━━━━━━━━━━━━━
`;
                  allGroupsList.forEach((g, i) => {
                    const icon = g.subStatus === 'Ativa' ? '[ON]' : '[OFF]';
                    text += `*${i + 1}.* ${g.name}\n   ${icon} | ${g.members} membros`;
                    if (g.subStatus === 'Ativa') text += ` | Expira: ${g.expira}`;
                    text += `\n\n`;
                  });
                  
                  text += `Envie o *numero* do grupo para configurar.\n\n╔══════════════════════════╗\n        ⚡ *SignaBOT* ⚡\n╚══════════════════════════╝`;
                  
                  await privateReply(text);
                  continue;
                }
              }
              
              // ── ADMIN: Listar grupos onde é admin ──
              if (adminGroups.length > 0) {
                pConfig.step = 'awaiting_group_selection';
                pConfig.adminGroups = adminGroups;
                saveDB('privateConfig', privateConfig);
                
                let text = `
╔══════════════════════════╗
  *PAINEL DE ADMIN — SignaBOT*
╚══════════════════════════╝

Ola, *${message.pushName || 'Admin'}*!
Voce e admin em *${adminGroups.length} grupo(s)*:

`;
                adminGroups.forEach((g, i) => {
                  const sub = checkSubscription(g.id);
                  const subStatus = sub.active ? 'Ativa' : 'Inativa';
                  const expira = sub.active ? ` | Expira: ${formatTime(sub.expiresAt - Date.now())}` : '';
                  text += `*${i + 1}.* ${g.name}\n   ${g.role} | Assinatura: ${subStatus}${expira}\n\n`;
                });
                
                text += `Envie o *numero* do grupo que deseja configurar.\n\n╔══════════════════════════╗\n        ⚡ *SignaBOT* ⚡\n╚══════════════════════════╝`;
                
                await privateReply(text);
                continue;
              } else {
                // ── NÃO É ADMIN: Redirecionar para compra ──
                await privateReply(`

Olá, *${message.pushName || 'Usuario'}*!

Ops! Você *não é administrador* e não possui assinatura ativa de nenhum
grupo onde o *SignaBOT* esta presente.

*Para usar o SignaBOT:*
1. Assine um plano
2. Adicione o bot ao seu grupo
3. Torne o bot admin do grupo

*Planos SignaBOT:*
  1 dias  — R$ 1,00
  7 dias  — R$ 5,00
  30 dias — R$ 10,00
  60 dias — R$ 15,00
  90 dias — R$ 20,00

  *PAGAMENTO PIX (MANUAL)*
  jeisiel-erick@jim.com

*Contato para assinar:*
wa.me/${OWNER_NUMBER}

╔══════════════════════════╗
      ⚡ *SignaBOT* ⚡
╚══════════════════════════╝`);
                continue;
              }
            } catch (err) {
              console.log('[PRIVADO] Erro ao buscar grupos:', err.message);
              logBotError('private_admin_detection', err);
              await privateReply('Erro ao processar. Tente novamente em alguns segundos.');
              continue;
            }
          }
        }

        // PROCESSAR COMANDOS (multi prefixos: #, /, !)
        if (body && PREFIXES.some(p => body.startsWith(p))) {
          const parts = body.trim().split(/\s+/);
          const rawCommand = parts[0].toLowerCase();
          // Normalizar comando para sempre usar # como prefixo interno
          const command = '#' + rawCommand.substring(1);
          const args = parts.slice(1);
          try {
            await handleCommand(sock, message, groupId, sender, command, args, isGroup);
          } catch (cmdErr) {
            console.log('[HANDLE_CMD] Erro:', cmdErr.message);
            logBotError(`handleCommand:${command}`, cmdErr);
          }
        }

      } catch (err) {
        console.log('[SignaBot] Erro ao processar mensagem: ' + err.message);
      }
    }
  });

  // ========== VERIFICAR ASSINATURAS EXPIRADAS A CADA MINUTO ==========
  setInterval(async () => {
    const now = Date.now();
    
    for (const [groupId, sub] of Object.entries(subscriptions)) {
      if (sub.expiresAt < now && !sub.notified) {
        try {
          // Registrar no histórico antes de notificar
          markGroupHistory(groupId, sub.type || 'paid', null);

          await sock.sendMessage(groupId, {
            text: `⚠️ *Assinatura Expirada*\n\nO período de ${sub.type === 'trial' ? 'teste grátis' : 'assinatura'} expirou.\n\nO bot está bloqueado até que o dono ative novamente com o comando:\n!ativar [30|60] dias\n\nContato do dono:\nwa.me/${OWNER_NUMBER}`,
          });
          
          subscriptions[groupId].notified = true;
          saveDB('subscriptions', subscriptions);
          console.log(`[SignaBot] Notificação de expiração enviada para ${groupId}`);
        } catch (err) {
          console.log(`[SignaBot] Erro ao notificar expiração: ${err.message}`);
        }
      }
    }
  }, 60000);

  // ============================================================
  // EVENTOS DE GRUPO (entrar/sair)
  // ============================================================

  sock.ev.on('group-participants.update', async ({ id: groupId, participants, action }) => {
    const settings = getGroupSettings(groupId);
    const sub = checkSubscription(groupId);
    if (!sub.active) return;

    if (action === 'add' && settings.welcome) {
      for (const participant of participants) {
        // Verificar lista negra
        if (blacklist[participant]) {
          try { await sock.groupParticipantsUpdate(groupId, [participant], 'remove'); } catch {}
          continue;
        }

        const welcomeMsg = settings.welcomeMsg ||
          `Bem-vindo(a) ao grupo, @${participant.split('@')[0]}!\n\nDigite #menu para ver os comandos disponíveis.`;

        try {
          const ppUrl = await sock.profilePictureUrl(participant, 'image').catch(() => null);
          if (ppUrl) {
            await sock.sendMessage(groupId, {
              image: { url: ppUrl },
              caption: welcomeMsg,
              mentions: [participant],
            });
          } else {
            await sock.sendMessage(groupId, {
              text: welcomeMsg,
              mentions: [participant],
            });
          }
        } catch {
          await sock.sendMessage(groupId, {
            text: welcomeMsg,
            mentions: [participant],
          }).catch(() => {});
        }
      }
    }

    if (action === 'remove') {
      for (const participant of participants) {
        if (settings.leaveMsg) {
          await sock.sendMessage(groupId, {
            text: settings.leaveMsg.replace('{nome}', `@${participant.split('@')[0]}`),
            mentions: [participant],
          }).catch(() => {});
        }
      }
    }
  });

  // Anti-chamada
  sock.ev.on('call', async (calls) => {
    for (const call of calls) {
      if (call.status === 'offer') {
        const groupId = call.from;
        const settings = getGroupSettings(groupId);
        if (settings.anticall) {
          await sock.rejectCall(call.id, call.from);
          await sock.sendMessage(call.from, {
            text: 'Chamadas nao sao permitidas! Por favor, use mensagens de texto.',
          }).catch(() => {});
        }
      }
    }
  });

  return sock;
};

// Iniciar bot
connectBot().catch(err => {
  console.log('[SignaBot] Erro fatal ao iniciar: ' + err.message);
  setTimeout(() => connectBot(), 10000);
});
