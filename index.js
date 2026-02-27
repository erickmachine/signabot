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
const { createCanvas, loadImage, registerFont } = require('canvas');

ffmpeg.setFfmpegPath(ffmpegPath);

// ============================================================
// SIGNABOT - Bot WhatsApp Completo
// ============================================================

const PREFIX = '#';
const PREFIX2 = '/';
const BOT_NAME = 'SignaBot';
const OWNER_NUMBER = '5592999652961';

// ========== Número do bot que aparece nos logs ==========
const BOT_NUMBER = '557183477259';

// ========== Lista de JIDs do dono com número do bot ==========
const OWNER_JIDS = [
  `${OWNER_NUMBER}@s.whatsapp.net`,
  '559299652961@s.whatsapp.net',
  `${BOT_NUMBER}@s.whatsapp.net`,
  '212171434754106@lid'
];

// ========== FUNÇÃO ISOWNER CORRIGIDA ==========
const isOwner = (sender) => {
  const isInList = OWNER_JIDS.includes(sender);
  
  let senderNumber = sender.split('@')[0];
  senderNumber = senderNumber.replace(/\D/g, '');
  
  const ownerNumber = OWNER_NUMBER.replace(/\D/g, '');
  const botNumber = BOT_NUMBER.replace(/\D/g, '');
  
  const isNumberMatch = senderNumber === ownerNumber || senderNumber === botNumber;
  
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
let cargos        = loadDB('cargos');
let afkList       = loadDB('afkList');
let autoMessages  = loadDB('autoMessages');
let rules         = loadDB('rules');

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
      welcomeMsg: 'Bem-vindo(a) ao grupo, @user! 🎉',
      welcomeImage: null,
      leaveMsg: '👋 @user saiu do grupo.',
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

// ========== FUNÇÃO PARA CRIAR IMAGEM DE BOAS-VINDAS ==========
const createWelcomeImage = async (userName, groupName, userTag) => {
  try {
    // Criar canvas 800x400
    const canvas = createCanvas(800, 400);
    const ctx = canvas.getContext('2d');

    // Fundo gradiente
    const gradient = ctx.createLinearGradient(0, 0, 800, 400);
    gradient.addColorStop(0, '#667eea');
    gradient.addColorStop(1, '#764ba2');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 800, 400);

    // Adicionar padrão de fundo
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 800; i += 40) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i + 400, 400);
      ctx.stroke();
    }

    // Título
    ctx.font = 'bold 40px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText('👋 BEM-VINDO!', 400, 80);

    // Nome do usuário
    ctx.font = 'bold 36px Arial';
    ctx.fillStyle = '#ffd700';
    ctx.fillText(userName, 400, 180);

    // Mensagem
    ctx.font = '24px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Ao grupo:', 400, 240);
    
    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = '#ffd700';
    ctx.fillText(groupName, 400, 290);

    // Regras básicas
    ctx.font = '18px Arial';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('📌 Leia as regras fixadas', 400, 340);
    ctx.fillText('🎉 Divirta-se com o SignaBOT!', 400, 380);

    // Tag do usuário
    ctx.font = '14px Arial';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(userTag, 400, 420);

    // Converter para buffer
    const buffer = canvas.toBuffer('image/png');
    
    // Salvar temporariamente
    const tempPath = path.join(__dirname, 'temp', `welcome_${Date.now()}.png`);
    if (!fs.existsSync(path.join(__dirname, 'temp'))) {
      fs.mkdirSync(path.join(__dirname, 'temp'), { recursive: true });
    }
    fs.writeFileSync(tempPath, buffer);
    
    return { buffer, path: tempPath };
  } catch (err) {
    console.log('[ERRO WELCOME IMAGE]', err);
    return null;
  }
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
  const skipSubCheck = ['!ativar', '!status', '!cancelar', '#ping', '#info', '#dono', '#menu'].includes(command)
    || command.startsWith('!') || ownerCheck;

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

if (command === '!ativar' || command === '#ativar') {
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
  
  console.log(`[ATIVAR] Assinatura ativada para ${groupId} até ${new Date(expiresAt).toLocaleString('pt-BR')}`);
  
  return reply(`✅ Assinatura ativada por ${days} dias!\nExpira em: ${new Date(expiresAt).toLocaleString('pt-BR')}`);
}

if (command === '!trial' || command === '#trial') {
  if (!ownerCheck) return reply('❌ Sem permissao.');
  if (!isGroup) return reply('❌ Use em um grupo.');
  const mins = parseInt(args[0]) || 10;
  subscriptions[groupId] = { type: 'trial', activatedAt: Date.now(), expiresAt: Date.now() + mins * 60000 };
  saveDB('subscriptions', subscriptions);
  return reply(`✅ Teste de ${mins} minuto(s) ativado!`);
}

if (command === '!cancelar' || command === '#cancelar') {
  if (!ownerCheck) return reply('❌ Sem permissao.');
  delete subscriptions[groupId];
  saveDB('subscriptions', subscriptions);
  return reply('✅ Assinatura cancelada.');
}

if (command === '!status' || command === '#status') {
  if (!isGroup) return reply('❌ Use em um grupo.');
  const sub = checkSubscription(groupId);
  if (!sub.active) return reply(`📊 Status: ${sub.reason}`);
  const left = sub.expiresAt - Date.now();
  return reply(`📊 *Status da Assinatura*\n\nTipo: ${sub.type === 'trial' ? 'Teste' : 'Pago'}\nRestante: ${formatTime(left)}\nExpira: ${new Date(sub.expiresAt).toLocaleString('pt-BR')}`);
}

  // ===========================================================
  // MENU PRINCIPAL
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
➤ Prefixo: #

📌 *MENUS DISPONÍVEIS*
➤ #menu figurinhas
➤ #menu download
➤ #menu admin
➤ #menu diversão
➤ #menu grupo
➤ #menu info
➤ #menu gold

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
➤ #setwelcome [texto]
➤ #setwelcomeimg [marcar imagem]
➤ #setleave [texto]
➤ #antilink [on/off]
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

╔══════════════════╗
      ⚡ SignaBOT ⚡
╚══════════════════╝
    `);
  }

  // ===========================================================
  // COMANDOS DE BOAS-VINDAS
  // ===========================================================

  // #bemvindo [on/off] - Ativar/desativar boas-vindas
  if (command === '#bemvindo') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    
    if (args[0] === 'on') {
      settings.welcome = true;
      saveSettings();
      return reply('✅ Boas-vindas ativadas!');
    }
    if (args[0] === 'off') {
      settings.welcome = false;
      saveSettings();
      return reply('✅ Boas-vindas desativadas.');
    }
    
    return reply(`📊 Status: ${settings.welcome ? 'Ativado' : 'Desativado'}\nUse: #bemvindo [on/off]`);
  }

  // #setwelcome [texto] - Definir mensagem de boas-vindas (use @user para mencionar)
  if (command === '#setwelcome') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    
    if (args.length === 0) {
      return reply('❌ Use: #setwelcome [texto]\nExemplo: #setwelcome Seja bem-vindo @user! 🎉');
    }
    
    settings.welcomeMsg = args.join(' ');
    saveSettings();
    return reply(`✅ Mensagem de boas-vindas definida:\n\n${settings.welcomeMsg}`);
  }

  // #setwelcomeimg [marcar imagem] - Definir imagem de boas-vindas
  if (command === '#setwelcomeimg') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    
    const quoted = getQuoted(message);
    const imageMsg = quoted?.imageMessage || message.message?.imageMessage;
    
    if (!imageMsg) {
      return reply('❌ Marque uma imagem para usar como fundo de boas-vindas!');
    }
    
    await reply('⏳ Salvando imagem de boas-vindas...');
    
    try {
      const buffer = await downloadMedia(imageMsg, 'image');
      
      // Salvar imagem na pasta do grupo
      const welcomeImgDir = path.join(__dirname, 'welcome_images');
      if (!fs.existsSync(welcomeImgDir)) {
        fs.mkdirSync(welcomeImgDir, { recursive: true });
      }
      
      const imgPath = path.join(welcomeImgDir, `${groupId.replace(/[^a-zA-Z0-9]/g, '_')}.png`);
      fs.writeFileSync(imgPath, buffer);
      
      settings.welcomeImage = imgPath;
      saveSettings();
      
      return reply('✅ Imagem de boas-vindas salva com sucesso!');
    } catch (err) {
      console.log('[ERRO SETWELCOMEIMG]', err);
      return reply('❌ Erro ao salvar imagem.');
    }
  }

  // #setleave [texto] - Definir mensagem de saída
  if (command === '#setleave') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    
    if (args.length === 0) {
      return reply('❌ Use: #setleave [texto]\nExemplo: #setleave @user saiu do grupo. Até mais! 👋');
    }
    
    settings.leaveMsg = args.join(' ');
    saveSettings();
    return reply(`✅ Mensagem de saída definida:\n\n${settings.leaveMsg}`);
  }

  // #testwelcome - Testar mensagem de boas-vindas
  if (command === '#testwelcome') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    
    const userName = senderName;
    const groupName = (await sock.groupMetadata(groupId)).subject;
    const userTag = `@${sender.split('@')[0]}`;
    
    // Tentar enviar imagem personalizada
    if (settings.welcomeImage && fs.existsSync(settings.welcomeImage)) {
      const welcomeImgBuffer = fs.readFileSync(settings.welcomeImage);
      
      // Se tiver imagem personalizada, usar ela
      await sock.sendMessage(groupId, {
        image: welcomeImgBuffer,
        caption: settings.welcomeMsg.replace(/@user/g, userTag),
        mentions: [sender]
      }, { quoted: message });
    } else {
      // Criar imagem dinâmica
      const welcomeImage = await createWelcomeImage(userName, groupName, userTag);
      
      if (welcomeImage) {
        await sock.sendMessage(groupId, {
          image: welcomeImage.buffer,
          caption: settings.welcomeMsg.replace(/@user/g, userTag),
          mentions: [sender]
        }, { quoted: message });
        
        // Limpar arquivo temporário
        fs.unlinkSync(welcomeImage.path);
      } else {
        // Fallback para texto
        const welcomeText = settings.welcomeMsg.replace(/@user/g, userTag);
        await sock.sendMessage(groupId, {
          text: welcomeText,
          mentions: [sender]
        }, { quoted: message });
      }
    }
  }

  // ===========================================================
  // FIGURINHAS
  // ===========================================================

  if (command === '#sticker' || command === '#s') {
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
      console.log('Erro Sticker:', err)
      return reply('❌ Erro ao criar figurinha.')
    }
  }

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

      const inputPath = path.join(__dirname, `sticker_${Date.now()}.webp`)
      const outputPath = path.join(__dirname, `gif_${Date.now()}.gif`)

      fs.writeFileSync(inputPath, buffer)

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

      const apiUrl = `https://api.xteam.xyz/ytdl?url=${encodeURIComponent(video.url)}&type=audio`;
      const { data } = await axios.get(apiUrl, { timeout: 30000 });
      if (!data?.url) return reply('Erro ao obter link de audio.');

      const audioResp = await axios.get(data.url, { responseType: 'arraybuffer', timeout: 60000 });
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

      const apiUrl = `https://api.xteam.xyz/ytdl?url=${encodeURIComponent(video.url)}&type=video`;
      const { data } = await axios.get(apiUrl, { timeout: 30000 });
      if (!data?.url) return reply('Erro ao obter link de video.');

      const videoResp = await axios.get(data.url, { responseType: 'arraybuffer', timeout: 120000 });
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

  if (command === '#tiktok') {
    if (args.length === 0) return reply('Use: #tiktok [URL do video]');
    const url = args[0];
    await reply('Baixando TikTok...');
    try {
      const { data } = await axios.get(
        `https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`,
        { timeout: 20000 }
      );
      if (!data?.video?.noWatermark) return reply('Erro ao obter link do video.');
      const videoResp = await axios.get(data.video.noWatermark, { responseType: 'arraybuffer', timeout: 60000 });
      const buffer = Buffer.from(videoResp.data);
      await sock.sendMessage(groupId, {
        video: buffer,
        caption: data.author?.nickname ? `@${data.author.nickname}` : '',
      }, { quoted: message });
    } catch (err) { return reply('Erro ao baixar TikTok: ' + err.message); }
    return;
  }

  if (command === '#instagram' || command === '#insta') {
    if (args.length === 0) return reply('Use: #instagram [URL]');
    const url = args[0];
    await reply('Baixando Instagram...');
    try {
      const { data } = await axios.get(
        `https://api.xteam.xyz/igdl?url=${encodeURIComponent(url)}`,
        { timeout: 20000 }
      );
      if (!data?.url) return reply('Erro ao baixar. Verifique se o link e valido e o perfil e publico.');
      const mediaResp = await axios.get(data.url, { responseType: 'arraybuffer', timeout: 60000 });
      const buffer = Buffer.from(mediaResp.data);
      const isVideo = data.type === 'video';
      if (isVideo) {
        await sock.sendMessage(groupId, { video: buffer, caption: 'Instagram' }, { quoted: message });
      } else {
        await sock.sendMessage(groupId, { image: buffer, caption: 'Instagram' }, { quoted: message });
      }
    } catch (err) { return reply('Erro ao baixar Instagram: ' + err.message); }
    return;
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
  // ADMINISTRACAO (comandos existentes)
  // ===========================================================

  if (command === '#ban') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('Marque o usuario para banir!');
    try {
      await sock.groupParticipantsUpdate(groupId, [mentioned[0]], 'remove');
      return reply(`Usuario banido com sucesso!`);
    } catch (err) { return reply('Erro ao banir: ' + err.message); }
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

  // SORTEIO
  if (command === '#sorteio') {
    try {
      const meta = await sock.groupMetadata(groupId);
      const botId = sock.user?.id;
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
  // COMANDO NAO ENCONTRADO (apenas se comecar com # ou /)
  // ===========================================================

  if (command.startsWith('#') || command.startsWith('/')) {
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
    if (settings.openAt === timeStr) {
      try {
        await sock.groupSettingUpdate(groupId, 'not_announcement');
        await sock.sendMessage(groupId, { text: 'O grupo abriu automaticamente! Bom dia a todos!' });
      } catch {}
    }
    if (settings.closeAt === timeStr) {
      try {
        await sock.groupSettingUpdate(groupId, 'announcement');
        await sock.sendMessage(groupId, { text: 'O grupo fechou automaticamente. Ate amanha!' });
      } catch {}
    }
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
  if (hour !== 9) return;

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

        if (blacklist[sender]) {
          if (isGroup) {
            try { await sock.groupParticipantsUpdate(groupId, [sender], 'remove'); } catch {}
          }
          continue;
        }

        if (isGroup) logActivity(groupId, sender);

        if (isGroup && muted[groupId]?.includes(sender)) {
          try {
            await sock.sendMessage(groupId, { delete: message.key });
          } catch {}
          continue;
        }

        const settings = isGroup ? getGroupSettings(groupId) : {};

        // ========== INICIAR TESTE GRÁTIS AUTOMATICAMENTE ==========
        if (isGroup && !subscriptions[groupId] && !blacklist[sender]) {
          subscriptions[groupId] = {
            type: 'trial',
            activatedAt: Date.now(),
            expiresAt: Date.now() + (10 * 60 * 1000),
            notified: false
          };
          saveDB('subscriptions', subscriptions);
          
          await sock.sendMessage(groupId, {
            text: `🎉 *Teste Grátis Ativado!*\n\n⏰ Duração: 10 minutos\n\nApós o teste, o bot será bloqueado até que o dono ative a assinatura com o comando:\n!ativar [30|60] dias\n\nContato do dono:\nwa.me/${OWNER_NUMBER}`,
          });
        }

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
                continue;
              }
            }

            if (settings.autoBaixar) {
              for (const url of urls) {
                if (url.includes('youtu')) {
                  try {
                    const apiUrl = `https://api.xteam.xyz/ytdl?url=${encodeURIComponent(url)}&type=audio`;
                    const { data } = await axios.get(apiUrl, { timeout: 30000 });
                    if (data?.url) {
                      const audioResp = await axios.get(data.url, { responseType: 'arraybuffer', timeout: 60000 });
                      await sock.sendMessage(groupId, { audio: Buffer.from(audioResp.data), mimetype: 'audio/mpeg', ptt: false }, { quoted: message });
                    }
                  } catch {}
                }
                if (url.includes('tiktok')) {
                  try {
                    const { data } = await axios.get(`https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`, { timeout: 20000 });
                    if (data?.video?.noWatermark) {
                      const resp = await axios.get(data.video.noWatermark, { responseType: 'arraybuffer', timeout: 60000 });
                      await sock.sendMessage(groupId, { video: Buffer.from(resp.data) }, { quoted: message });
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

        // SO-ADM
        if (isGroup && settings.soAdm && body) {
          const isAdminSender = await isAdmin(sock, groupId, sender);
          if (!isAdminSender && !isOwner(sender) && !hasCargo(groupId, sender, 'admin', 'mod', 'aux')) {
            try { await sock.sendMessage(groupId, { delete: message.key }); } catch {}
            continue;
          }
        }

        // VERIFICAR AFK
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

        // PROCESSAR COMANDOS
        if (body && (body.startsWith(PREFIX) || body.startsWith(PREFIX2))) {
          const parts = body.trim().split(/\s+/);
          const command = parts[0].toLowerCase();
          const args = parts.slice(1);
          await handleCommand(sock, message, groupId, sender, command, args, isGroup);
        }

      } catch (err) {
        console.log('[SignaBot] Erro ao processar mensagem: ' + err.message);
      }
    }
  });

  // ========== VERIFICAR ASSINATURAS EXPIRADAS ==========
  setInterval(async () => {
    const now = Date.now();
    
    for (const [groupId, sub] of Object.entries(subscriptions)) {
      if (sub.expiresAt < now && !sub.notified) {
        try {
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
  // EVENTOS DE GRUPO (entrar/sair) - BOAS-VINDAS PERSONALIZADAS
  // ============================================================

  sock.ev.on('group-participants.update', async ({ id: groupId, participants, action }) => {
    const settings = getGroupSettings(groupId);
    const sub = checkSubscription(groupId);
    if (!sub.active) return;

    if (action === 'add' && settings.welcome) {
      for (const participant of participants) {
        if (blacklist[participant]) {
          try { await sock.groupParticipantsUpdate(groupId, [participant], 'remove'); } catch {}
          continue;
        }

        try {
          const groupMetadata = await sock.groupMetadata(groupId);
          const groupName = groupMetadata.subject;
          const participantName = participant.split('@')[0];
          const pushName = (await sock.getName(participant)) || participantName;
          
          // Verificar se tem imagem personalizada
          if (settings.welcomeImage && fs.existsSync(settings.welcomeImage)) {
            // Enviar imagem personalizada
            const welcomeImgBuffer = fs.readFileSync(settings.welcomeImage);
            const welcomeText = settings.welcomeMsg.replace(/@user/g, `@${participantName}`);
            
            await sock.sendMessage(groupId, {
              image: welcomeImgBuffer,
              caption: welcomeText,
              mentions: [participant]
            });
          } else {
            // Criar imagem dinâmica
            const welcomeImage = await createWelcomeImage(pushName, groupName, `@${participantName}`);
            
            if (welcomeImage) {
              const welcomeText = settings.welcomeMsg.replace(/@user/g, `@${participantName}`);
              
              await sock.sendMessage(groupId, {
                image: welcomeImage.buffer,
                caption: welcomeText,
                mentions: [participant]
              });
              
              // Limpar arquivo temporário
              fs.unlinkSync(welcomeImage.path);
            } else {
              // Fallback para texto
              const welcomeText = settings.welcomeMsg.replace(/@user/g, `@${participantName}`);
              await sock.sendMessage(groupId, {
                text: welcomeText,
                mentions: [participant]
              });
            }
          }
        } catch (err) {
          console.log('[ERRO WELCOME]', err);
          // Fallback para texto simples
          await sock.sendMessage(groupId, {
            text: `👋 Bem-vindo(a) ao grupo!`,
            mentions: [participant]
          }).catch(() => {});
        }
      }
    }

    if (action === 'remove') {
      for (const participant of participants) {
        if (settings.leaveMsg) {
          const leaveText = settings.leaveMsg.replace(/@user/g, `@${participant.split('@')[0]}`);
          await sock.sendMessage(groupId, {
            text: leaveText,
            mentions: [participant]
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
