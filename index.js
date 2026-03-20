const { default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  downloadContentFromMessage,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { execFile } = require('child_process');

ffmpeg.setFfmpegPath(ffmpegPath);

// ============================================================
// SIGNABOT - Bot WhatsApp Completo
// ============================================================

const PREFIXES = ['#', '/', '!'];
const BOT_NAME = 'SignaBot';
const OWNER_NUMBER = '5592999652961';
const BOT_NUMBER = '557183477259';

const OWNER_JIDS = [
  `${OWNER_NUMBER}@s.whatsapp.net`,
  '559299652961@s.whatsapp.net',
  `${BOT_NUMBER}@s.whatsapp.net`,
  '212171434754106@lid'
];

const isOwner = (sender) => {
  const isInList = OWNER_JIDS.includes(sender);
  let senderNumber = sender.split('@')[0];
  senderNumber = senderNumber.replace(/\D/g, '');
  const ownerNumber = OWNER_NUMBER.replace(/\D/g, '');
  const botNumber = BOT_NUMBER.replace(/\D/g, '');
  const isNumberMatch = senderNumber === ownerNumber || senderNumber === botNumber;
  return isInList || isNumberMatch;
};

// ============================================================
// BANCO DE DADOS JSON LOCAL
// ============================================================

const DATA_DIR = path.join(__dirname, 'database');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const MEDIA_DIR = path.join(__dirname, 'media');
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

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
let customCmds    = loadDB('customCmds');
let privateConfig = loadDB('privateConfig');
let botLogs       = loadDB('botLogs');
let groupHistory  = loadDB('groupHistory');
let shop          = loadDB('shop'); // Lojinha: { groupId: { productId: { name, price, description, images: [], seller, createdAt } } }

if (!botLogs.errors) botLogs.errors = [];
if (!botLogs.actions) botLogs.actions = [];

const logBotError = (context, error) => {
  botLogs.errors.push({
    time: Date.now(),
    context,
    error: error?.message || String(error),
    stack: error?.stack?.split('\n').slice(0, 3).join(' | ') || ''
  });
  if (botLogs.errors.length > 100) botLogs.errors = botLogs.errors.slice(-100);
  saveDB('botLogs', botLogs);
};

const logBotAction = (action, details) => {
  botLogs.actions.push({ time: Date.now(), action, details });
  if (botLogs.actions.length > 200) botLogs.actions = botLogs.actions.slice(-200);
  saveDB('botLogs', botLogs);
};

// ============================================================
// HISTÓRICO DE GRUPOS (anti-burla de trial)
// ============================================================

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

const groupOrNumberHasHistory = (groupId, senderNumber) => {
  const hist = groupHistory[groupId];
  if (hist && (hist.hadTrial || hist.hadPaid)) return true;
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
      shopEnabled: true,
    };
    saveDB('groupSettings', groupSettings);
  }
  return groupSettings[groupId];
};

const saveSettings = () => saveDB('groupSettings', groupSettings);

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

const downloadMedia = async (msgContent, type) => {
  try {
    const stream = await downloadContentFromMessage(msgContent, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return buffer;
  } catch { return null; }
};

// Função para substituir variáveis no texto
const replaceVars = (text, vars) => {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`@${key}|\\{${key}\\}`, 'gi'), value);
  }
  return result;
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
  const cargoCheck = (gId, ...c) => ownerCheck || adminCheck || hasCargo(gId, sender, ...c);

  console.log(`[COMANDO] ${command} de ${sender} - Dono: ${ownerCheck}`);

  const skipSubCheck = [
    '#ativar', '#status', '#cancelar', '#trial',
    '#ping', '#info', '#dono', '#menu', '#sender', '#horario', '#feedback',
    '#dicatech', '#vercomandos', '#listacmd', '#loja', '#produtos'
  ].includes(command) || ownerCheck;

  if (isGroup && !skipSubCheck) {
    const sub = checkSubscription(groupId);
    if (!sub.active) {
      return reply(`⚠️ Aviso: ${sub.reason}. Entre em contato com o dono para ativar.`);
    }
  }

  const settings = isGroup ? getGroupSettings(groupId) : {};

  // ===========================================================
  // ASSINATURA (dono)
  // ===========================================================

  if (command === '#ativar') {
    if (!ownerCheck) return reply('❌ Sem permissao.');
    if (!isGroup) return reply('❌ Use em um grupo.');
    const days = parseInt(args[0]);
    if (![7, 15, 30, 60, 90].includes(days)) return reply('❌ Use: #ativar [7|15|30|60|90] dias');
    const expiresAt = Date.now() + days * 86400000;
    subscriptions[groupId] = { type: 'paid', activatedAt: Date.now(), expiresAt, days };
    saveDB('subscriptions', subscriptions);
    markGroupHistory(groupId, 'paid', sender.split('@')[0]);
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
  // MENU PRINCIPAL
  // ===========================================================

  if (command === '#menu') {
    const sub = args[0]?.toLowerCase();
    const dataAtual = new Date().toLocaleDateString('pt-BR');
    const horaAtual = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    if (!sub) {
      const menuPrincipal = `
╔══════════════════╗
     🤖 *MENU PRINCIPAL* 🤖
╚══════════════════╝

👤 *USUÁRIO*
➤ Nome: ${senderName}
➤ Data: ${dataAtual}
➤ Hora: ${horaAtual}
➤ Prefixos: # / !

📌 *MENUS DISPONÍVEIS*
➤ #menu figurinhas
➤ #menu admin
➤ #menu diversão
➤ #menu grupo
➤ #menu info
➤ #menu loja
➤ #menu tecnologia
➤ #menu comandos
➤ #menu utilidades

⚡ *COMANDOS RÁPIDOS*
➤ #ping
➤ #dono
➤ #status

╔══════════════════╗
      ⚡ *SignaBOT* ⚡
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
     📦 *MENU FIGURINHAS* 📦
╚══════════════════╝

🖼️ *CRIAR FIGURINHA*
➤ #sticker — Criar figurinha
➤ #fig — Criar figurinha
➤ #s — Atalho rápido

📝 *TEXTO PARA FIGURINHA*
➤ #ttp [texto]
➤ #attp [texto]

🔄 *CONVERSORES*
➤ #toimg — Sticker para imagem
➤ #togif — Sticker para GIF

✏️ *EDIÇÃO*
➤ #take [autor] [pack]

╔══════════════════╗
      ⚡ *SignaBOT* ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU ADMIN
    // ===========================================================
    if (sub === 'admin' || sub === 'adm') {
      if (!cargoCheck(groupId, 'admin', 'mod')) {
        return reply(`❌ Apenas administradores podem ver este menu.`);
      }

      return reply(`
╔══════════════════╗
     🛡️ *MENU ADMIN* 🛡️
╚══════════════════╝

👥 *GERENCIAR MEMBROS*
➤ #ban @user — Banir membro
➤ #add 559999999999 — Adicionar
➤ #promover @user — Promover admin
➤ #rebaixar @user — Rebaixar admin
➤ #cargo @user [admin|mod|aux]
➤ #mute @user — Mutar membro
➤ #desmute @user — Desmutar

⚠️ *ADVERTÊNCIAS*
➤ #advertir @user [motivo]
➤ #checkwarnings @user
➤ #removewarnings @user
➤ #setlimitec [num]
➤ #advertidos — Lista advertidos

📢 *MARCAÇÃO*
➤ #marcar [texto]
➤ #tagall [texto]

⚙️ *CONFIGURAÇÕES*
➤ #bemvindo [on/off]
➤ #bemvindo_msg [texto]
➤ #antilink [on/off]
➤ #antivendas [on/off]
➤ #so_adm [on/off]
➤ #anticall [on/off]
➤ #x9visuunica [on/off]

🔒 *CONTROLE DO GRUPO*
➤ #fechargp — Fechar grupo
➤ #abrirgp — Abrir grupo
➤ #banghost — Remover inativos
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

⏰ *MENSAGENS AGENDADAS*
➤ #agendar [tempo] [texto]
  Exemplos:
  #agendar 30m Lembrete!
  #agendar 2h Bom dia!
  #agendar 08:00 Mensagem fixa
➤ #veragendamentos
➤ #cancelaragendamento [id]

🗒️ *NOTAS*
➤ #anotar [texto]
➤ #anotacao
➤ #tirar_nota [num]

🚨 *FILTRO DE PALAVRAS*
➤ #antipalavra [on/off]
➤ #addpalavra [palavra]
➤ #delpalavra [palavra]
➤ #listapalavrao

🛒 *LOJA*
➤ #loja [on/off]
➤ #produtos — Ver produtos

╔══════════════════╗
      ⚡ *SignaBOT* ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU LOJA
    // ===========================================================
    if (sub === 'loja' || sub === 'shop') {
      return reply(`
╔══════════════════╗
     🛒 *MENU LOJA* 🛒
╚══════════════════╝

📦 *ANUNCIAR PRODUTOS*
➤ #anunciar
  (Envie com imagem + texto)
  Formato do texto:
  Nome: Produto X
  Preço: R$ 100,00
  Descrição: Texto aqui

➤ #anunciar [nome] | [preço] | [desc]
  (Sem imagem)

📋 *GERENCIAR*
➤ #produtos — Ver todos produtos
➤ #produto [id] — Ver detalhes
➤ #meusprodutos — Seus anúncios
➤ #deletarproduto [id]

🔔 *CONFIGURAÇÃO (Admin)*
➤ #loja on — Ativar loja
➤ #loja off — Desativar loja

💡 *DICAS*
• Envie uma imagem com a legenda
  começando com #anunciar
• Use | para separar campos
• Anúncios aparecem com selo especial

╔══════════════════╗
      ⚡ *SignaBOT* ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU DIVERSÃO
    // ===========================================================
    if (sub === 'diversão' || sub === 'div') {
      return reply(`
╔══════════════════╗
     🎮 *MENU DIVERSÃO* 🎮
╚══════════════════╝

🎯 *JOGOS*
➤ #ppt [pedra/papel/tesoura]
➤ #dado [lados]
➤ #8ball [pergunta]

💘 *RELACIONAMENTOS*
➤ #casal — Sortear casal
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
➤ #sorteio [texto]

╔══════════════════╗
      ⚡ *SignaBOT* ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU GRUPO
    // ===========================================================
    if (sub === 'grupo' || sub === 'gp') {
      return reply(`
╔══════════════════╗
     👥 *MENU GRUPO* 👥
╚══════════════════╝

📊 *ESTATÍSTICAS*
➤ #rankativos — Mais ativos
➤ #inativos [dias]
➤ #gpinfo — Info do grupo
➤ #admins — Lista admins

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
      ⚡ *SignaBOT* ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU INFO
    // ===========================================================
    if (sub === 'info' || sub === 'informações') {
      return reply(`
╔══════════════════╗
     ℹ️ *MENU INFO* ℹ️
╚══════════════════╝

🤖 *SOBRE O BOT*
➤ #info
➤ #ping
➤ #dono

📱 *USUÁRIO*
➤ #perfil [@user]
➤ #sender

💰 *ASSINATURA*
➤ #status
➤ #ativar [dias]
➤ #cancelar

╔══════════════════╗
      ⚡ *SignaBOT* ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU UTILIDADES
    // ===========================================================
    if (sub === 'utilidades' || sub === 'util') {
      return reply(`
╔══════════════════╗
     🔧 *MENU UTILIDADES* 🔧
╚══════════════════╝

📝 *CÁLCULOS*
➤ #imc [peso] [altura]
➤ #calculadora [expressão]

🌐 *CONSULTAS*
➤ #cep [CEP]
➤ #clima [cidade]
➤ #horario
➤ #signo [DD/MM]

🌍 *TRADUÇÃO*
➤ #traduzir [idioma] [texto]
  Idiomas: en, es, fr, de, pt

🔐 *SEGURANÇA*
➤ #siteseguro [url]
➤ #senhasegura [senha]
➤ #gerarsenha [tamanho]

╔══════════════════╗
      ⚡ *SignaBOT* ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU TECNOLOGIA
    // ===========================================================
    if (sub === 'tecnologia' || sub === 'tech') {
      return reply(`
╔══════════════════╗
     🖥️ *MENU TECNOLOGIA* 🖥️
╚══════════════════╝

🌐 *INTERNET*
➤ #testarnet
➤ #meuip
➤ #meudns
➤ #pingtest [host]

📱 *DISPOSITIVOS*
➤ #limparcache
➤ #economizarbateria
➤ #liberarmemoria
➤ #modoaviao

🛠️ *DICAS*
➤ #dicatech — Dica aleatória
➤ #atalhos [windows/mac/android]
➤ #resetarmodem
➤ #melhorarsinal

╔══════════════════╗
      ⚡ *SignaBOT* ⚡
╚══════════════════╝
      `);
    }

    // ===========================================================
    // MENU COMANDOS PERSONALIZADOS
    // ===========================================================
    if (sub === 'comandos' || sub === 'cmd') {
      return reply(`
╔══════════════════╗
     📝 *COMANDOS PERSONALIZADOS* 📝
╚══════════════════╝

📌 *CRIAR COMANDO*
➤ #comando [nome] [texto]
  (Pode enviar com imagem!)

📋 *GERENCIAR*
➤ #vercomandos
➤ #delcomando [nome]

💡 *COMO USAR*
1. Envie uma imagem com legenda:
   #comando saudacao Olá!
2. Ou apenas texto:
   #comando regra1 Não faça spam

⚠️ O texto fica EXATAMENTE como
   você digitou (com formatação).

╔══════════════════╗
      ⚡ *SignaBOT* ⚡
╚══════════════════╝
      `);
    }

    return reply(`❌ Submenu não encontrado.\nUse #menu para ver os disponíveis.`);
  }

  // ===========================================================
  // SISTEMA DE LOJINHA
  // ===========================================================

  if (command === '#loja') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    
    if (args[0] === 'on') {
      if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
      settings.shopEnabled = true;
      saveSettings();
      return reply('✅ Loja ativada! Membros podem anunciar com #anunciar');
    }
    
    if (args[0] === 'off') {
      if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
      settings.shopEnabled = false;
      saveSettings();
      return reply('✅ Loja desativada.');
    }
    
    return reply(`🛒 *Loja:* ${settings.shopEnabled !== false ? 'Ativada' : 'Desativada'}\n\nUse #menu loja para ver comandos.`);
  }

  if (command === '#anunciar') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    if (settings.shopEnabled === false) return reply('❌ A loja está desativada neste grupo.');
    
    const imageMsg = message.message?.imageMessage;
    let productName = '';
    let productPrice = '';
    let productDesc = '';
    let imageBuffer = null;
    let imagePath = null;
    
    // Se enviou com imagem
    if (imageMsg) {
      const caption = imageMsg.caption || '';
      const captionText = caption.replace(/^#anunciar\s*/i, '').trim();
      
      // Tentar extrair campos do caption
      const nameMatch = captionText.match(/nome:\s*(.+?)(?:\n|preço:|preco:|$)/i);
      const priceMatch = captionText.match(/pre[çc]o:\s*(.+?)(?:\n|descri[çc][aã]o:|desc:|$)/i);
      const descMatch = captionText.match(/(?:descri[çc][aã]o|desc):\s*(.+)/is);
      
      if (nameMatch) productName = nameMatch[1].trim();
      if (priceMatch) productPrice = priceMatch[1].trim();
      if (descMatch) productDesc = descMatch[1].trim();
      
      // Se não encontrou formato estruturado, usa o texto todo como descrição
      if (!productName && !productPrice && captionText) {
        const parts = captionText.split('|').map(p => p.trim());
        if (parts.length >= 2) {
          productName = parts[0];
          productPrice = parts[1];
          productDesc = parts[2] || '';
        } else {
          productDesc = captionText;
        }
      }
      
      // Baixar imagem
      try {
        imageBuffer = await downloadMedia(imageMsg, 'image');
        if (imageBuffer) {
          const imgId = Date.now().toString(36);
          imagePath = path.join(MEDIA_DIR, `product_${groupId.split('@')[0]}_${imgId}.jpg`);
          fs.writeFileSync(imagePath, imageBuffer);
        }
      } catch (e) {
        console.log('Erro ao baixar imagem do produto:', e.message);
      }
    } else {
      // Sem imagem, texto puro
      const text = args.join(' ');
      const parts = text.split('|').map(p => p.trim());
      if (parts.length >= 2) {
        productName = parts[0];
        productPrice = parts[1];
        productDesc = parts[2] || '';
      } else {
        return reply(`❌ Formato inválido!\n\nUse:\n#anunciar Nome | Preço | Descrição\n\nOu envie uma imagem com:\nNome: Produto\nPreço: R$ 100\nDescrição: Texto`);
      }
    }
    
    if (!productName && !productDesc) {
      return reply(`❌ Informe pelo menos o nome ou descrição do produto.\n\nExemplo:\n#anunciar Camiseta | R$ 50 | Tamanho M`);
    }
    
    // Gerar ID do produto
    const productId = 'PRD_' + Date.now().toString(36).toUpperCase();
    
    // Salvar no banco
    if (!shop[groupId]) shop[groupId] = {};
    shop[groupId][productId] = {
      name: productName || 'Sem nome',
      price: productPrice || 'Sob consulta',
      description: productDesc,
      imagePath: imagePath,
      seller: sender,
      sellerName: senderName,
      createdAt: Date.now()
    };
    saveDB('shop', shop);
    
    // Criar anúncio bonito
    const anuncio = `
╔══════════════════════════╗
   🏷️ *ANÚNCIO ESPECIAL* 🏷️
╚══════════════════════════╝

🛍️ *${productName || 'Produto'}*

💰 *Preço:* ${productPrice || 'Sob consulta'}

📝 *Descrição:*
${productDesc || 'Sem descrição'}

👤 *Vendedor:* @${sender.split('@')[0]}
🆔 *ID:* ${productId}

━━━━━━━━━━━━━━━━━━━━━━━━
💬 Interessado? Chame o vendedor!
━━━━━━━━━━━━━━━━━━━━━━━━

╔══════════════════════════╗
      🛒 *LOJA SignaBOT* 🛒
╚══════════════════════════╝
    `;
    
    // Enviar anúncio
    if (imageBuffer) {
      await sock.sendMessage(groupId, {
        image: imageBuffer,
        caption: anuncio,
        mentions: [sender]
      });
    } else {
      await sock.sendMessage(groupId, {
        text: anuncio,
        mentions: [sender]
      });
    }
    
    logBotAction('new_product', `${productId} por ${sender.split('@')[0]} em ${groupId}`);
    return;
  }

  if (command === '#produtos') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    
    const products = shop[groupId];
    if (!products || !Object.keys(products).length) {
      return reply('📦 Nenhum produto anunciado neste grupo.\n\nUse #anunciar para criar um anúncio!');
    }
    
    let text = `
╔══════════════════════════╗
   🛒 *PRODUTOS DO GRUPO* 🛒
╚══════════════════════════╝

`;
    const mentions = [];
    
    Object.entries(products).slice(0, 10).forEach(([id, p], i) => {
      const shortName = p.name.length > 25 ? p.name.substring(0, 25) + '...' : p.name;
      text += `*${i + 1}.* ${shortName}\n`;
      text += `   💰 ${p.price}\n`;
      text += `   👤 @${p.seller.split('@')[0]}\n`;
      text += `   🆔 ${id}\n\n`;
      if (!mentions.includes(p.seller)) mentions.push(p.seller);
    });
    
    text += `\nUse #produto [ID] para ver detalhes.`;
    
    return sock.sendMessage(groupId, { text, mentions });
  }

  if (command === '#produto') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    
    const productId = args[0]?.toUpperCase();
    if (!productId) return reply('❌ Use: #produto [ID]\nEx: #produto PRD_ABC123');
    
    const product = shop[groupId]?.[productId];
    if (!product) return reply('❌ Produto não encontrado.');
    
    const text = `
╔══════════════════════════╗
   🏷️ *DETALHES DO PRODUTO* 🏷️
╚══════════════════════════╝

🛍️ *${product.name}*

💰 *Preço:* ${product.price}

📝 *Descrição:*
${product.description || 'Sem descrição'}

👤 *Vendedor:* @${product.seller.split('@')[0]}
📅 *Anunciado:* ${new Date(product.createdAt).toLocaleDateString('pt-BR')}
🆔 *ID:* ${productId}

━━━━━━━━━━━━━━━━━━━━━━━━
💬 Chame o vendedor se interessou!
━━━━━━━━━━━━━━━━━━━━━━━━
    `;
    
    if (product.imagePath && fs.existsSync(product.imagePath)) {
      const imgBuffer = fs.readFileSync(product.imagePath);
      await sock.sendMessage(groupId, {
        image: imgBuffer,
        caption: text,
        mentions: [product.seller]
      });
    } else {
      await sock.sendMessage(groupId, {
        text,
        mentions: [product.seller]
      });
    }
    return;
  }

  if (command === '#meusprodutos') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    
    const products = shop[groupId];
    if (!products) return reply('📦 Nenhum produto no grupo.');
    
    const myProducts = Object.entries(products).filter(([, p]) => p.seller === sender);
    if (!myProducts.length) return reply('📦 Você não tem produtos anunciados.');
    
    let text = `*Seus Produtos:*\n\n`;
    myProducts.forEach(([id, p], i) => {
      text += `${i + 1}. ${p.name} — ${p.price}\n   ID: ${id}\n\n`;
    });
    text += `\nUse #deletarproduto [ID] para remover.`;
    
    return reply(text);
  }

  if (command === '#deletarproduto') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    
    const productId = args[0]?.toUpperCase();
    if (!productId) return reply('❌ Use: #deletarproduto [ID]');
    
    const product = shop[groupId]?.[productId];
    if (!product) return reply('❌ Produto não encontrado.');
    
    // Apenas dono do produto, admin ou dono do bot pode deletar
    if (product.seller !== sender && !adminCheck && !ownerCheck) {
      return reply('❌ Você só pode deletar seus próprios produtos.');
    }
    
    // Remover imagem se existir
    if (product.imagePath && fs.existsSync(product.imagePath)) {
      try { fs.unlinkSync(product.imagePath); } catch {}
    }
    
    delete shop[groupId][productId];
    saveDB('shop', shop);
    
    return reply(`✅ Produto ${productId} removido!`);
  }

  // ===========================================================
  // AGENDAMENTO DE MENSAGENS (MINUTOS, HORAS OU HORÁRIO FIXO)
  // ===========================================================

  if (command === '#agendar') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    
    if (args.length < 2) {
      return reply(`❌ *Formato de uso:*

*Por minutos:*
#agendar 30m Mensagem aqui

*Por horas:*
#agendar 2h Mensagem aqui

*Horário fixo (diário):*
#agendar 08:00 Bom dia!

*Com dias específicos:*
#agendar 08:00 seg,qua,sex Bom dia!`);
    }
    
    const timeArg = args[0].toLowerCase();
    let scheduleType = '';
    let executeAt = 0;
    let repeatTime = null;
    let repeatDays = 'todos';
    let msgText = '';
    
    // Verificar se é minutos (30m, 45m, etc)
    if (timeArg.endsWith('m') && /^\d+m$/.test(timeArg)) {
      const minutes = parseInt(timeArg.replace('m', ''));
      if (minutes < 1 || minutes > 1440) {
        return reply('❌ Minutos deve ser entre 1 e 1440 (24 horas).');
      }
      scheduleType = 'once';
      executeAt = Date.now() + (minutes * 60 * 1000);
      msgText = args.slice(1).join(' ');
    }
    // Verificar se é horas (2h, 12h, etc)
    else if (timeArg.endsWith('h') && /^\d+h$/.test(timeArg)) {
      const hours = parseInt(timeArg.replace('h', ''));
      if (hours < 1 || hours > 168) {
        return reply('❌ Horas deve ser entre 1 e 168 (1 semana).');
      }
      scheduleType = 'once';
      executeAt = Date.now() + (hours * 60 * 60 * 1000);
      msgText = args.slice(1).join(' ');
    }
    // Verificar se é horário fixo (HH:MM)
    else if (/^\d{2}:\d{2}$/.test(timeArg)) {
      scheduleType = 'daily';
      repeatTime = timeArg;
      
      // Verificar se tem dias específicos
      const nextArg = args[1]?.toLowerCase();
      const daysPattern = /^(seg|ter|qua|qui|sex|sab|dom)(,(seg|ter|qua|qui|sex|sab|dom))*$/i;
      
      if (daysPattern.test(nextArg)) {
        repeatDays = nextArg;
        msgText = args.slice(2).join(' ');
      } else {
        msgText = args.slice(1).join(' ');
      }
    } else {
      return reply(`❌ Formato inválido!

Use:
• 30m para 30 minutos
• 2h para 2 horas
• 08:00 para horário fixo`);
    }
    
    if (!msgText.trim()) {
      return reply('❌ Informe a mensagem a ser enviada.');
    }
    
    // Gerar ID do agendamento
    const schedId = 'SCH_' + Date.now().toString(36).toUpperCase();
    
    if (!autoMessages[groupId]) autoMessages[groupId] = {};
    autoMessages[groupId][schedId] = {
      type: scheduleType,
      time: repeatTime,
      executeAt: executeAt,
      days: repeatDays,
      text: msgText, // Preserva formatação original
      active: true,
      creator: sender,
      createdAt: Date.now()
    };
    saveDB('autoMessages', autoMessages);
    
    let confirmMsg = `✅ *Mensagem Agendada!*\n\n🆔 ID: ${schedId}\n`;
    
    if (scheduleType === 'once') {
      const execDate = new Date(executeAt);
      confirmMsg += `⏰ Será enviada em: ${execDate.toLocaleString('pt-BR')}\n`;
    } else {
      confirmMsg += `⏰ Horário: ${repeatTime}\n`;
      confirmMsg += `📅 Dias: ${repeatDays}\n`;
    }
    
    confirmMsg += `\n📝 Mensagem:\n${msgText}`;
    
    logBotAction('schedule_msg', `${schedId} em ${groupId}`);
    return reply(confirmMsg);
  }

  if (command === '#veragendamentos' || command === '#listar-mensagens-automaticas') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    
    const scheds = autoMessages[groupId];
    if (!scheds || !Object.keys(scheds).length) {
      return reply('📅 Nenhuma mensagem agendada.\n\nUse #agendar para criar.');
    }
    
    let text = `*📅 Mensagens Agendadas:*\n\n`;
    
    Object.entries(scheds).forEach(([id, s], i) => {
      const preview = s.text.length > 40 ? s.text.substring(0, 40) + '...' : s.text;
      text += `*${i + 1}.* ${id}\n`;
      
      if (s.type === 'once') {
        const execDate = new Date(s.executeAt);
        if (s.executeAt > Date.now()) {
          text += `   ⏰ Em: ${execDate.toLocaleString('pt-BR')}\n`;
        } else {
          text += `   ✅ Já enviada\n`;
        }
      } else {
        text += `   ⏰ ${s.time} | Dias: ${s.days || 'todos'}\n`;
      }
      text += `   📝 ${preview}\n\n`;
    });
    
    text += `\nUse #cancelaragendamento [ID] para remover.`;
    
    return reply(text);
  }

  if (command === '#cancelaragendamento' || command === '#delagenda' || command === '#limpar-mensagem-automatica') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    
    const schedId = args[0]?.toUpperCase();
    if (!schedId) return reply('❌ Use: #cancelaragendamento [ID]');
    
    if (!autoMessages[groupId]?.[schedId]) {
      return reply('❌ Agendamento não encontrado.');
    }
    
    delete autoMessages[groupId][schedId];
    saveDB('autoMessages', autoMessages);
    
    return reply(`✅ Agendamento ${schedId} cancelado!`);
  }

  if (command === '#limpar-mensagens-automaticas') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    
    const count = Object.keys(autoMessages[groupId] || {}).length;
    autoMessages[groupId] = {};
    saveDB('autoMessages', autoMessages);
    
    return reply(`✅ ${count} agendamento(s) removido(s)!`);
  }

  // ===========================================================
  // FIGURINHAS
  // ===========================================================

  if (command === '#sticker' || command === '#s' || command === '#fig') {
    const quoted = getQuoted(message);
    const imageMsg = quoted?.imageMessage || message.message?.imageMessage;
    const videoMsg = quoted?.videoMessage || message.message?.videoMessage;

    if (!imageMsg && !videoMsg) {
      return reply('❌ Marque uma imagem ou vídeo (máx 10s)');
    }

    await reply('⏳ Criando sua figurinha...');

    try {
      if (imageMsg) {
        const buffer = await downloadMedia(imageMsg, 'image');
        const webpBuffer = await sharp(buffer)
          .resize(512, 512, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          })
          .webp({ quality: 80 })
          .toBuffer();

        await sock.sendMessage(groupId, {
          sticker: webpBuffer,
          packname: 'SignaBot',
          author: senderName
        }, { quoted: message });
        return;
      }

      if (videoMsg) {
        if (videoMsg.seconds > 10) {
          return reply('❌ O vídeo deve ter no máximo 10 segundos.');
        }

        const videoBuffer = await downloadMedia(videoMsg, 'video');
        const inputPath = path.join(__dirname, `input_${Date.now()}.mp4`);
        const outputPath = path.join(__dirname, `output_${Date.now()}.webp`);

        fs.writeFileSync(inputPath, videoBuffer);

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
            .on('error', reject);
        });

        const webpBuffer = fs.readFileSync(outputPath);
        await sock.sendMessage(groupId, {
          sticker: webpBuffer,
          packname: 'SignaBot',
          author: senderName
        }, { quoted: message });

        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
        return;
      }
    } catch (err) {
      console.log('Erro Sticker:', err);
      return reply('❌ Erro ao criar figurinha.');
    }
  }

  if (command === '#toimg') {
    const quoted = getQuoted(message);
    const stickerMsg = quoted?.stickerMessage || message.message?.stickerMessage;

    if (!stickerMsg) {
      return reply('❌ Marque uma figurinha para converter em imagem!');
    }

    await reply('⏳ Convertendo figurinha para imagem...');

    try {
      const buffer = await downloadMedia(stickerMsg, 'sticker');
      if (!buffer) return reply('❌ Erro ao baixar figurinha.');

      const pngBuffer = await sharp(buffer).png().toBuffer();

      await sock.sendMessage(groupId, {
        image: pngBuffer,
        caption: '✅ Imagem convertida com sucesso!'
      }, { quoted: message });

    } catch (err) {
      console.log('Erro #toimg:', err);
      return reply('❌ Erro ao converter figurinha.');
    }
  }

  if (command === '#take') {
    const quoted = getQuoted(message);
    const stickerMsg = quoted?.stickerMessage || message.message?.stickerMessage;

    if (!stickerMsg) {
      return reply('❌ Marque uma figurinha para editar!');
    }

    const author = args[0] || 'SignaBot';
    const pack = args[1] || 'Stickers';

    await reply(`⏳ Alterando figurinha...\nAutor: ${author}\nPack: ${pack}`);

    try {
      const buffer = await downloadMedia(stickerMsg, 'sticker');
      if (!buffer) return reply('❌ Erro ao baixar figurinha.');

      await sock.sendMessage(groupId, {
        sticker: buffer,
        packname: pack,
        author: author
      }, { quoted: message });

    } catch (err) {
      console.log('Erro #take:', err);
      return reply('❌ Erro ao editar figurinha.');
    }
  }

  // ===========================================================
  // ADMINISTRAÇÃO
  // ===========================================================

  if (command === '#ban') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    
    const quotedParticipant = getQuotedSender(message);
    const mentioned = getMentioned(message);
    
    let targetUser = quotedParticipant || (mentioned.length ? mentioned[0] : null);
    
    if (!targetUser) return reply('❌ Mencione ou responda a mensagem do usuário que deseja banir!');
    
    try {
      const quotedKey = message.message?.extendedTextMessage?.contextInfo;
      if (quotedKey?.stanzaId) {
        await sock.sendMessage(groupId, { delete: {
          remoteJid: groupId,
          fromMe: false,
          id: quotedKey.stanzaId,
          participant: quotedKey.participant,
        }}).catch(() => {});
      }
      
      await sock.groupParticipantsUpdate(groupId, [targetUser], 'remove');
      return reply(`✅ Usuário @${targetUser.split('@')[0]} banido com sucesso!`);
    } catch (err) { return reply('❌ Erro ao banir: ' + err.message); }
  }

  if (command === '#add') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    if (!args[0]) return reply('❌ Use: #add [numero com DDI]\nEx: #add 5592999999999');
    const num = args[0].replace(/\D/g, '') + '@s.whatsapp.net';
    try {
      await sock.groupParticipantsUpdate(groupId, [num], 'add');
      return reply('✅ Membro adicionado!');
    } catch (err) { return reply('❌ Erro ao adicionar: ' + err.message); }
  }

  if (command === '#promover') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissão.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('❌ Marque o usuário!');
    try {
      await sock.groupParticipantsUpdate(groupId, [mentioned[0]], 'promote');
      return reply('✅ Usuário promovido a admin!');
    } catch (err) { return reply('❌ Erro: ' + err.message); }
  }

  if (command === '#rebaixar') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissão.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('❌ Marque o usuário!');
    try {
      await sock.groupParticipantsUpdate(groupId, [mentioned[0]], 'demote');
      return reply('✅ Admin rebaixado!');
    } catch (err) { return reply('❌ Erro: ' + err.message); }
  }

  if (command === '#cargo') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissão.');
    const mentioned = getMentioned(message);
    if (!mentioned.length || !args[1]) return reply('❌ Use: #cargo @usuario [admin|mod|aux|remover]');
    const userId = mentioned[0];
    const novoCargo = args[1].toLowerCase();
    if (!['admin', 'mod', 'aux', 'remover'].includes(novoCargo)) return reply('❌ Cargos válidos: admin, mod, aux, remover');
    if (!cargos[groupId]) cargos[groupId] = {};
    if (novoCargo === 'remover') { delete cargos[groupId][userId]; }
    else { cargos[groupId][userId] = novoCargo; }
    saveDB('cargos', cargos);
    return reply(novoCargo === 'remover' ? '✅ Cargo removido!' : `✅ Cargo "${novoCargo}" atribuído!`);
  }

  if (command === '#advertir') {
    if (!cargoCheck(groupId, 'admin', 'mod', 'aux')) return reply('❌ Sem permissão.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('❌ Marque o usuário para advertir!');
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
          text: `⚠️ Usuário banido por atingir ${limit} advertências!\nMotivo: ${motivo}`,
          mentions: [userId],
        });
      } catch (err) { return reply('❌ Erro ao banir: ' + err.message); }
    }
    return sock.sendMessage(groupId, {
      text: `⚠️ Advertência ${count}/${limit} aplicada!\nMotivo: ${motivo}`,
      mentions: [userId],
    });
  }

  if (command === '#checkwarnings' || command === '#ver_adv') {
    const mentioned = getMentioned(message);
    const userId = mentioned.length ? mentioned[0] : sender;
    const userWarns = warnings[groupId]?.[userId];
    if (!userWarns || !userWarns.length) return reply('✅ Sem advertências.');
    const limit = settings.warningLimit || 3;
    let text = `⚠️ *Advertências:* ${userWarns.length}/${limit}\n\n`;
    userWarns.forEach((w, i) => {
      text += `${i + 1}. ${new Date(w.date).toLocaleString('pt-BR')}\n   Motivo: ${w.motivo}\n\n`;
    });
    return reply(text);
  }

  if (command === '#removewarnings' || command === '#rm_adv') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('❌ Marque o usuário!');
    const userId = mentioned[0];
    if (warnings[groupId]) delete warnings[groupId][userId];
    saveDB('warnings', warnings);
    return reply('✅ Advertências removidas!');
  }

  if (command === '#advertidos') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    const grpWarns = warnings[groupId];
    if (!grpWarns || !Object.keys(grpWarns).length) return reply('✅ Nenhum usuário advertido.');
    let text = '*Usuários com advertências:*\n\n';
    const mentions = [];
    Object.entries(grpWarns).forEach(([uid, warns]) => {
      if (warns.length > 0) { text += `@${uid.split('@')[0]}: ${warns.length} adv.\n`; mentions.push(uid); }
    });
    return sock.sendMessage(groupId, { text, mentions });
  }

  if (command === '#marcar' || command === '#tagall' || command === '#totag') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    try {
      const meta = await sock.groupMetadata(groupId);
      const participants = meta.participants.map(p => p.id);
      const text = args.join(' ') || 'Marcação geral!';
      await sock.sendMessage(groupId, { text: `📢 *Marcação Geral*\n\n${text}`, mentions: participants });
    } catch (err) { return reply('❌ Erro: ' + err.message); }
    return;
  }

  if (command === '#deletar' || command === '#del') {
    if (!cargoCheck(groupId, 'admin', 'mod', 'aux')) return reply('❌ Sem permissão.');
    const quoted = getQuoted(message);
    if (!quoted) return reply('❌ Marque a mensagem para deletar!');
    const quotedKey = message.message?.extendedTextMessage?.contextInfo;
    if (!quotedKey) return reply('❌ Não foi possível identificar a mensagem.');
    try {
      await sock.sendMessage(groupId, { delete: {
        remoteJid: groupId,
        fromMe: false,
        id: quotedKey.stanzaId,
        participant: quotedKey.participant,
      }});
    } catch { return reply('❌ Não consegui apagar (preciso ser admin).'); }
    return;
  }

  if (command === '#fechargp') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    try {
      await sock.groupSettingUpdate(groupId, 'announcement');
      return reply('🔒 Grupo fechado! Apenas admins podem enviar.');
    } catch (err) { return reply('❌ Erro: ' + err.message); }
  }

  if (command === '#abrirgp') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    try {
      await sock.groupSettingUpdate(groupId, 'not_announcement');
      return reply('🔓 Grupo aberto! Todos podem enviar.');
    } catch (err) { return reply('❌ Erro: ' + err.message); }
  }

  if (command === '#linkgp') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    try {
      const code = await sock.groupInviteCode(groupId);
      return reply(`🔗 *Link do grupo:*\nhttps://chat.whatsapp.com/${code}`);
    } catch (err) { return reply('❌ Erro: ' + err.message); }
  }

  if (command === '#nomegp') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissão.');
    if (!args.length) return reply('❌ Use: #nomegp [novo nome]');
    try {
      await sock.groupUpdateSubject(groupId, args.join(' '));
      return reply('✅ Nome do grupo alterado!');
    } catch (err) { return reply('❌ Erro: ' + err.message); }
  }

  if (command === '#descgp') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissão.');
    if (!args.length) return reply('❌ Use: #descgp [nova descrição]');
    try {
      await sock.groupUpdateDescription(groupId, args.join(' '));
      return reply('✅ Descrição alterada!');
    } catch (err) { return reply('❌ Erro: ' + err.message); }
  }

  if (command === '#regras') {
    if (!args.length) {
      const r = rules[groupId];
      return reply(r ? `📋 *Regras do grupo:*\n\n${r}` : '❌ Nenhuma regra definida.');
    }
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    rules[groupId] = args.join(' ');
    saveDB('rules', rules);
    return reply('✅ Regras definidas!');
  }

  if (command === '#gpinfo') {
    try {
      const meta = await sock.groupMetadata(groupId);
      const admins = meta.participants.filter(p => p.admin).length;
      return reply(`📊 *Informações do Grupo*\n\n📛 Nome: ${meta.subject}\n📝 Descrição: ${meta.desc || '-'}\n📅 Criado: ${new Date(meta.creation * 1000).toLocaleString('pt-BR')}\n👥 Membros: ${meta.participants.length}\n👑 Admins: ${admins}`);
    } catch (err) { return reply('❌ Erro: ' + err.message); }
  }

  if (command === '#admins') {
    try {
      const meta = await sock.groupMetadata(groupId);
      const admins = meta.participants.filter(p => p.admin);
      let text = '*👑 Admins do grupo:*\n\n';
      admins.forEach(a => { text += `➤ @${a.id.split('@')[0]}\n`; });
      return sock.sendMessage(groupId, { text, mentions: admins.map(a => a.id) });
    } catch { return reply('❌ Erro ao buscar admins.'); }
  }

  // ===========================================================
  // CONFIGURAÇÕES DE GRUPO
  // ===========================================================

  if (command === '#bemvindo') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    if (args[0] === 'on') { settings.welcome = true; saveSettings(); return reply('✅ Boas-vindas ativadas!'); }
    if (args[0] === 'off') { settings.welcome = false; saveSettings(); return reply('✅ Boas-vindas desativadas.'); }
    return reply(`📢 Boas-vindas: ${settings.welcome ? '✅ Ativado' : '❌ Desativado'}\nUse: #bemvindo [on/off]`);
  }

  if (command === '#bemvindo_msg') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    if (!args.length) return reply('❌ Use: #bemvindo_msg [texto]\n\nVariáveis: @user @group @desc @numero @membros');
    settings.welcomeMsg = args.join(' ');
    saveSettings();
    return reply(`✅ Mensagem de boas-vindas definida:\n\n${settings.welcomeMsg}`);
  }

  if (command === '#antilink') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    if (args[0] === 'on') { settings.antilink = true; saveSettings(); return reply('✅ Antilink ativado!'); }
    if (args[0] === 'off') { settings.antilink = false; saveSettings(); return reply('✅ Antilink desativado.'); }
    return reply(`🔗 Antilink: ${settings.antilink ? '✅ Ativado' : '❌ Desativado'}\nUse: #antilink [on/off]`);
  }

  if (command === '#antivendas') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    if (args[0] === 'on') { settings.antiVendas = true; saveSettings(); return reply('✅ Anti-vendas ativado!'); }
    if (args[0] === 'off') { settings.antiVendas = false; saveSettings(); return reply('✅ Anti-vendas desativado.'); }
    return reply(`🚫 Anti-vendas: ${settings.antiVendas ? '✅ Ativado' : '❌ Desativado'}\nUse: #antivendas [on/off]`);
  }

  if (command === '#so_adm') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissão.');
    if (args[0] === 'on') { settings.soAdm = true; saveSettings(); return reply('✅ Modo só-admins ativado!'); }
    if (args[0] === 'off') { settings.soAdm = false; saveSettings(); return reply('✅ Modo só-admins desativado.'); }
    return reply(`🔒 Só-admins: ${settings.soAdm ? '✅ Ativado' : '❌ Desativado'}\nUse: #so_adm [on/off]`);
  }

  if (command === '#x9visuunica' || command === '#antiviewonce') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    if (args[0] === 'on') { settings.antiViewOnce = true; saveSettings(); return reply('✅ Revelar visualização única ativado!'); }
    if (args[0] === 'off') { settings.antiViewOnce = false; saveSettings(); return reply('✅ Revelar visualização única desativado.'); }
    return reply(`👁️ Revelar V.U.: ${settings.antiViewOnce ? '✅ Ativado' : '❌ Desativado'}\nUse: #x9visuunica [on/off]`);
  }

  if (command === '#antipalavra') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    if (args[0] === 'on') { settings.antiPalavra = true; saveSettings(); return reply('✅ Anti-palavrão ativado!'); }
    if (args[0] === 'off') { settings.antiPalavra = false; saveSettings(); return reply('✅ Anti-palavrão desativado.'); }
    return reply(`🚫 Anti-palavrão: ${settings.antiPalavra ? '✅ Ativado' : '❌ Desativado'}\nUse: #antipalavra [on/off]`);
  }

  if (command === '#addpalavra') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    if (!args[0]) return reply('❌ Use: #addpalavra [palavra]');
    if (!settings.palavroes) settings.palavroes = [];
    const word = args[0].toLowerCase();
    if (settings.palavroes.includes(word)) return reply('❌ Palavra já está na lista.');
    settings.palavroes.push(word);
    saveSettings();
    return reply(`✅ Palavra "${word}" adicionada ao filtro.`);
  }

  if (command === '#delpalavra') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    if (!args[0]) return reply('❌ Use: #delpalavra [palavra]');
    if (!settings.palavroes) return reply('❌ Lista vazia.');
    const word = args[0].toLowerCase();
    const idx = settings.palavroes.indexOf(word);
    if (idx === -1) return reply('❌ Palavra não encontrada.');
    settings.palavroes.splice(idx, 1);
    saveSettings();
    return reply(`✅ Palavra "${word}" removida do filtro.`);
  }

  if (command === '#listapalavrao') {
    if (!settings.palavroes?.length) return reply('📋 Lista de palavras proibidas: vazia');
    return reply(`📋 *Palavras proibidas:*\n\n${settings.palavroes.join(', ')}`);
  }

  // ===========================================================
  // LISTA NEGRA
  // ===========================================================

  if (command === '#listanegra') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    
    if (args[0] === 'add') {
      if (!args[1]) return reply('❌ Use: #listanegra add [numero]');
      const num = args[1].replace(/\D/g, '') + '@s.whatsapp.net';
      blacklist[num] = { date: Date.now(), reason: 'Adicionado manualmente' };
      saveDB('blacklist', blacklist);
      return reply(`✅ ${args[1]} adicionado à lista negra.`);
    }
    
    if (args[0] === 'rem' || args[0] === 'remove') {
      if (!args[1]) return reply('❌ Use: #listanegra rem [numero]');
      const num = args[1].replace(/\D/g, '') + '@s.whatsapp.net';
      if (!blacklist[num]) return reply('❌ Número não está na lista negra.');
      delete blacklist[num];
      saveDB('blacklist', blacklist);
      return reply(`✅ ${args[1]} removido da lista negra.`);
    }
    
    if (args[0] === 'ver' || !args[0]) {
      const list = Object.keys(blacklist);
      if (!list.length) return reply('📋 Lista negra: vazia');
      let text = '*📋 Lista Negra:*\n\n';
      list.forEach((num, i) => {
        text += `${i + 1}. ${num.split('@')[0]}\n`;
      });
      return reply(text);
    }
    
    return reply('❌ Use: #listanegra [add|rem|ver] [numero]');
  }

  // ===========================================================
  // AFK / AUSENTE
  // ===========================================================

  if (command === '#ausente' || command === '#afk') {
    const msg = args.join(' ') || 'Estou ausente';
    afkList[sender] = { msg, time: Date.now() };
    saveDB('afkList', afkList);
    return reply(`💤 Você está marcado como ausente.\nMensagem: ${msg}`);
  }

  if (command === '#ativo') {
    if (!afkList[sender]) return reply('✅ Você não estava ausente.');
    const afk = afkList[sender];
    delete afkList[sender];
    saveDB('afkList', afkList);
    return reply(`✅ Bem-vindo de volta! Você ficou ausente por ${formatTime(Date.now() - afk.time)}`);
  }

  if (command === '#listarafk') {
    const afks = Object.entries(afkList);
    if (!afks.length) return reply('✅ Ninguém está ausente.');
    let text = '*💤 Usuários Ausentes:*\n\n';
    const mentions = [];
    afks.forEach(([uid, data]) => {
      text += `@${uid.split('@')[0]}: ${data.msg}\n`;
      mentions.push(uid);
    });
    return sock.sendMessage(groupId, { text, mentions });
  }

  // ===========================================================
  // COMANDOS PERSONALIZADOS
  // ===========================================================

  if (command === '#comando') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    
    const imageMsg = message.message?.imageMessage;
    let cmdName = args[0]?.toLowerCase();
    let cmdText = args.slice(1).join(' ');
    
    if (imageMsg) {
      const caption = imageMsg.caption || '';
      const parts = caption.replace(/^#comando\s*/i, '').trim().split(/\s+/);
      cmdName = parts[0]?.toLowerCase();
      cmdText = parts.slice(1).join(' ');
    }
    
    if (!cmdName) return reply('❌ Use: #comando [nome] [texto]');
    
    let imagePath = null;
    if (imageMsg) {
      try {
        const buffer = await downloadMedia(imageMsg, 'image');
        if (buffer) {
          imagePath = path.join(MEDIA_DIR, `cmd_${groupId.split('@')[0]}_${cmdName}.jpg`);
          fs.writeFileSync(imagePath, buffer);
        }
      } catch {}
    }
    
    if (!customCmds[groupId]) customCmds[groupId] = {};
    customCmds[groupId][cmdName] = {
      text: cmdText, // Preserva formatação original
      imagePath,
      creator: sender,
      createdAt: Date.now()
    };
    saveDB('customCmds', customCmds);
    
    return reply(`✅ Comando *#${cmdName}* criado!\n${imagePath ? '📷 Com imagem' : ''}\n${cmdText ? `📝 ${cmdText.substring(0, 50)}...` : ''}`);
  }

  if (command === '#vercomandos' || command === '#listacmd') {
    const cmds = customCmds[groupId];
    if (!cmds || !Object.keys(cmds).length) return reply('📋 Nenhum comando personalizado.\n\nUse #comando [nome] [texto] para criar.');
    
    let text = '*📋 Comandos Personalizados:*\n\n';
    Object.entries(cmds).forEach(([name, cmd], i) => {
      const hasImg = cmd.imagePath ? '📷' : '';
      const preview = cmd.text ? (cmd.text.length > 30 ? cmd.text.substring(0, 30) + '...' : cmd.text) : '';
      text += `${i + 1}. #${name} ${hasImg}\n   ${preview}\n`;
    });
    
    return reply(text);
  }

  if (command === '#delcomando') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    const cmdName = args[0]?.toLowerCase();
    if (!cmdName) return reply('❌ Use: #delcomando [nome]');
    if (!customCmds[groupId]?.[cmdName]) return reply('❌ Comando não encontrado.');
    
    if (customCmds[groupId][cmdName].imagePath) {
      try { fs.unlinkSync(customCmds[groupId][cmdName].imagePath); } catch {}
    }
    delete customCmds[groupId][cmdName];
    saveDB('customCmds', customCmds);
    
    return reply(`✅ Comando #${cmdName} deletado!`);
  }

  // Executar comando personalizado
  const cmdName = command.substring(1).toLowerCase();
  if (customCmds[groupId]?.[cmdName]) {
    const cmd = customCmds[groupId][cmdName];
    
    if (cmd.imagePath && fs.existsSync(cmd.imagePath)) {
      const imgBuffer = fs.readFileSync(cmd.imagePath);
      await sock.sendMessage(groupId, {
        image: imgBuffer,
        caption: cmd.text || ''
      }, { quoted: message });
    } else if (cmd.text) {
      await reply(cmd.text);
    }
    return;
  }

  // ===========================================================
  // NOTAS
  // ===========================================================

  if (command === '#anotar') {
    if (!args.length) return reply('❌ Use: #anotar [texto]');
    if (!notes[groupId]) notes[groupId] = [];
    notes[groupId].push({
      text: args.join(' '),
      author: sender,
      date: Date.now()
    });
    saveDB('notes', notes);
    return reply(`✅ Nota #${notes[groupId].length} adicionada!`);
  }

  if (command === '#anotacao' || command === '#notas') {
    if (!notes[groupId]?.length) return reply('📋 Nenhuma nota registrada.');
    let text = '*📋 Notas do Grupo:*\n\n';
    notes[groupId].forEach((n, i) => {
      text += `*${i + 1}.* ${n.text}\n   📅 ${new Date(n.date).toLocaleString('pt-BR')}\n\n`;
    });
    return reply(text);
  }

  if (command === '#tirar_nota') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissão.');
    const idx = parseInt(args[0]) - 1;
    if (isNaN(idx) || !notes[groupId]?.[idx]) return reply('❌ Nota não encontrada.');
    notes[groupId].splice(idx, 1);
    saveDB('notes', notes);
    return reply('✅ Nota removida!');
  }

  // ===========================================================
  // SORTEIO
  // ===========================================================

  if (command === '#sorteio') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    try {
      const meta = await sock.groupMetadata(groupId);
      const participants = meta.participants.map(p => p.id);
      const winner = participants[Math.floor(Math.random() * participants.length)];
      const prize = args.join(' ') || 'Prêmio misterioso';
      
      await sock.sendMessage(groupId, {
        text: `🎉 *SORTEIO*\n\n🏆 Prêmio: ${prize}\n\n🎊 Vencedor: @${winner.split('@')[0]}\n\nParabéns!`,
        mentions: [winner]
      });
    } catch (err) { return reply('❌ Erro: ' + err.message); }
    return;
  }

  // ===========================================================
  // JOGOS E DIVERSÃO
  // ===========================================================

  if (command === '#ppt') {
    const choices = ['pedra', 'papel', 'tesoura'];
    const userChoice = args[0]?.toLowerCase();
    if (!choices.includes(userChoice)) return reply('❌ Use: #ppt [pedra|papel|tesoura]');
    const botChoice = choices[Math.floor(Math.random() * 3)];
    
    let result = '';
    if (userChoice === botChoice) result = '🤝 Empate!';
    else if (
      (userChoice === 'pedra' && botChoice === 'tesoura') ||
      (userChoice === 'papel' && botChoice === 'pedra') ||
      (userChoice === 'tesoura' && botChoice === 'papel')
    ) result = '🎉 Você venceu!';
    else result = '😢 Você perdeu!';
    
    return reply(`🎮 *Pedra, Papel, Tesoura*\n\n👤 Você: ${userChoice}\n🤖 Bot: ${botChoice}\n\n${result}`);
  }

  if (command === '#dado') {
    const sides = parseInt(args[0]) || 6;
    if (sides < 2 || sides > 100) return reply('❌ O dado deve ter entre 2 e 100 lados.');
    const result = Math.floor(Math.random() * sides) + 1;
    return reply(`🎲 *Dado de ${sides} lados*\n\nResultado: *${result}*`);
  }

  if (command === '#8ball') {
    if (!args.length) return reply('❌ Use: #8ball [pergunta]');
    const answers = [
      '✅ Sim, com certeza!',
      '✅ Definitivamente sim!',
      '🤔 Provavelmente sim',
      '🤷 Talvez...',
      '🤔 Não tenho certeza',
      '❌ Provavelmente não',
      '❌ Não!',
      '❌ Definitivamente não!',
      '🔮 Pergunte novamente depois',
      '🎱 Os sinais apontam que sim'
    ];
    const answer = answers[Math.floor(Math.random() * answers.length)];
    return reply(`🎱 *Bola 8 Mágica*\n\n❓ ${args.join(' ')}\n\n${answer}`);
  }

  if (command === '#casal') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    try {
      const meta = await sock.groupMetadata(groupId);
      const participants = meta.participants.map(p => p.id);
      if (participants.length < 2) return reply('❌ Precisa de pelo menos 2 membros.');
      
      const shuffled = participants.sort(() => Math.random() - 0.5);
      const p1 = shuffled[0];
      const p2 = shuffled[1];
      
      await sock.sendMessage(groupId, {
        text: `💕 *Casal do Dia*\n\n❤️ @${p1.split('@')[0]}\n💞\n❤️ @${p2.split('@')[0]}\n\nSeriam um belo casal!`,
        mentions: [p1, p2]
      });
    } catch (err) { return reply('❌ Erro: ' + err.message); }
    return;
  }

  if (command === '#ship') {
    const mentioned = getMentioned(message);
    if (mentioned.length < 2) return reply('❌ Use: #ship @usuario1 @usuario2');
    const pct = Math.floor(Math.random() * 101);
    let emoji = pct >= 80 ? '💕' : pct >= 60 ? '❤️' : pct >= 40 ? '💛' : pct >= 20 ? '💔' : '❌';
    return sock.sendMessage(groupId, {
      text: `💘 *Compatibilidade*\n\n👤 @${mentioned[0].split('@')[0]}\n💞 x\n👤 @${mentioned[1].split('@')[0]}\n\n${emoji} Compatibilidade: *${pct}%*`,
      mentions: mentioned
    });
  }

  if (command === '#porcentagem' || command === '#chance') {
    if (!args.length) return reply('❌ Use: #porcentagem [texto]');
    const pct = Math.floor(Math.random() * 101);
    return reply(`📊 *Porcentagem*\n\n❓ ${args.join(' ')}\n\n🎯 Resultado: *${pct}%*`);
  }

  // ===========================================================
  // RANKINGS
  // ===========================================================

  if (command === '#rankativos') {
    if (!isGroup) return reply('❌ Use em um grupo.');
    const activity = userActivity[groupId];
    if (!activity || !Object.keys(activity).length) return reply('📊 Sem dados de atividade.');
    
    const sorted = Object.entries(activity)
      .sort(([,a], [,b]) => b.messageCount - a.messageCount)
      .slice(0, 10);
    
    let text = '*🏆 Top 10 Mais Ativos:*\n\n';
    const mentions = [];
    sorted.forEach(([uid, data], i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      text += `${medal} @${uid.split('@')[0]} — ${data.messageCount} msgs\n`;
      mentions.push(uid);
    });
    
    return sock.sendMessage(groupId, { text, mentions });
  }

  // ===========================================================
  // UTILIDADES
  // ===========================================================

  if (command === '#ping') {
    const start = Date.now();
    await reply('🏓 Pong!');
    const latency = Date.now() - start;
    return reply(`⚡ Latência: ${latency}ms`);
  }

  if (command === '#info') {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    
    return reply(`
🤖 *SignaBOT - Informações*

📛 Nome: ${BOT_NAME}
⏰ Uptime: ${hours}h ${mins}m
🔧 Versão: 2.0.0
👨‍💻 Dono: wa.me/${OWNER_NUMBER}

📊 *Estatísticas:*
📦 Grupos ativos: ${Object.keys(subscriptions).length}
📝 Comandos: 100+
    `);
  }

  if (command === '#dono') {
    return reply(`👑 *Dono do Bot:*\n\n📱 wa.me/${OWNER_NUMBER}\n\n💬 Entre em contato para:\n• Adquirir plano\n• Reportar bugs\n• Sugestões`);
  }

  if (command === '#sender') {
    return reply(`📱 *Seu ID:*\n${sender}`);
  }

  if (command === '#horario') {
    const agora = new Date();
    return reply(`🕐 *Horário Atual*\n\n📅 ${agora.toLocaleDateString('pt-BR')}\n⏰ ${agora.toLocaleTimeString('pt-BR')}`);
  }

  if (command === '#cep') {
    if (!args[0]) return reply('❌ Use: #cep [CEP]');
    try {
      const { data } = await axios.get(`https://viacep.com.br/ws/${args[0].replace(/\D/g, '')}/json/`);
      if (data.erro) return reply('❌ CEP não encontrado.');
      return reply(`📍 *Consulta CEP*\n\n📫 CEP: ${data.cep}\n🏠 Rua: ${data.logradouro || '-'}\n🏘️ Bairro: ${data.bairro || '-'}\n🏙️ Cidade: ${data.localidade}\n🗺️ Estado: ${data.uf}`);
    } catch { return reply('❌ Erro ao consultar CEP.'); }
  }

  if (command === '#clima') {
    if (!args.length) return reply('❌ Use: #clima [cidade]');
    try {
      const city = encodeURIComponent(args.join(' '));
      const { data } = await axios.get(`https://wttr.in/${city}?format=j1`, { timeout: 10000 });
      const current = data.current_condition?.[0];
      if (!current) return reply('❌ Cidade não encontrada.');
      
      return reply(`🌤️ *Clima em ${args.join(' ')}*\n\n🌡️ Temperatura: ${current.temp_C}°C\n🤔 Sensação: ${current.FeelsLikeC}°C\n💧 Umidade: ${current.humidity}%\n💨 Vento: ${current.windspeedKmph} km/h`);
    } catch { return reply('❌ Erro ao buscar clima.'); }
  }

  if (command === '#imc') {
    if (args.length < 2) return reply('❌ Use: #imc [peso] [altura]\nEx: #imc 70 1.75');
    const peso = parseFloat(args[0].replace(',', '.'));
    const altura = parseFloat(args[1].replace(',', '.'));
    if (isNaN(peso) || isNaN(altura)) return reply('❌ Valores inválidos.');
    
    const imc = peso / (altura * altura);
    let classificacao = '';
    if (imc < 18.5) classificacao = 'Abaixo do peso';
    else if (imc < 25) classificacao = 'Peso normal';
    else if (imc < 30) classificacao = 'Sobrepeso';
    else if (imc < 35) classificacao = 'Obesidade grau I';
    else if (imc < 40) classificacao = 'Obesidade grau II';
    else classificacao = 'Obesidade grau III';
    
    return reply(`📊 *Cálculo de IMC*\n\n⚖️ Peso: ${peso} kg\n📏 Altura: ${altura} m\n\n📈 IMC: ${imc.toFixed(2)}\n📋 Classificação: ${classificacao}`);
  }

  if (command === '#calculadora' || command === '#calc') {
    if (!args.length) return reply('❌ Use: #calculadora [expressão]\nEx: #calc 2+2*5');
    try {
      const expr = args.join(' ').replace(/[^0-9+\-*/.()%\s]/g, '');
      const result = eval(expr);
      return reply(`🔢 *Calculadora*\n\n📝 ${expr}\n📊 = ${result}`);
    } catch { return reply('❌ Expressão inválida.'); }
  }

  if (command === '#traduzir' || command === '#tr') {
    if (args.length < 2) return reply('❌ Use: #traduzir [idioma] [texto]\nIdiomas: en, es, fr, de, pt');
    const lang = args[0].toLowerCase();
    const text = args.slice(1).join(' ');
    try {
      const { data } = await axios.get(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=pt|${lang}`, { timeout: 10000 });
      const translated = data?.responseData?.translatedText;
      if (!translated) return reply('❌ Erro ao traduzir.');
      return reply(`🌐 *Tradução*\n\n📝 Original: ${text}\n🔄 Traduzido (${lang}): ${translated}`);
    } catch { return reply('❌ Erro ao traduzir.'); }
  }

  if (command === '#gerarsenha') {
    const tamanho = parseInt(args[0]) || 16;
    if (tamanho < 6 || tamanho > 64) return reply('❌ Tamanho: 6-64 caracteres.');
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%&*()-_=+';
    let senha = '';
    for (let i = 0; i < tamanho; i++) {
      senha += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return reply(`🔐 *Senha Gerada*\n\n\`\`\`${senha}\`\`\`\n\n📏 Tamanho: ${tamanho} caracteres`);
  }

  if (command === '#dicatech') {
    const dicas = [
      '💡 Ctrl+Shift+T reabre abas fechadas no navegador!',
      '💡 *texto* para negrito, _texto_ para itálico no WhatsApp.',
      '💡 Use DNS 1.1.1.1 (Cloudflare) para navegar mais rápido!',
      '💡 Ctrl+L seleciona a barra de endereço instantaneamente.',
      '💡 No YouTube: K pausa, J volta 10s, L avança 10s.',
      '💡 Use 2FA em todas suas contas importantes!',
      '💡 Windows+V abre o histórico da área de transferência.',
      '💡 Modo avião faz o celular carregar mais rápido!',
      '💡 Ctrl+F busca palavras em qualquer página.',
      '💡 No WhatsApp Web, Ctrl+Shift+M muta conversa.'
    ];
    return reply(dicas[Math.floor(Math.random() * dicas.length)]);
  }

  // Comando não reconhecido
  return;
};

// ============================================================
// CONEXÃO DO BOT
// ============================================================

const connectBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    auth: state,
    browser: ['SignaBot', 'Chrome', '120.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  let reconnectAttempts = 0;
  let fatal405Count = 0;

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('[SignaBot] Escaneie o QR Code:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error;
      const boom = reason instanceof Boom ? reason : null;
      const statusCode = boom?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[SignaBot] Conexão fechada. Código: ${statusCode}. Reconectar: ${shouldReconnect}`);

      if (!shouldReconnect) {
        console.log('[SignaBot] Sessão encerrada. Delete a pasta auth_info e reconecte.');
        reconnectAttempts = 0;
        fatal405Count = 0;
        setTimeout(() => connectBot(), 10000);
        return;
      }

      if (statusCode === 405 || statusCode === 403) {
        fatal405Count++;
        if (fatal405Count >= 3) {
          console.log('[SignaBot] IP bloqueado. Aguardando 10 minutos...');
          fatal405Count = 0;
          setTimeout(() => connectBot(), 10 * 60 * 1000);
        } else {
          const delay = fatal405Count * 60000;
          setTimeout(() => connectBot(), delay);
        }
        return;
      }

      const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
      reconnectAttempts++;
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
          try { await sock.sendMessage(groupId, { delete: message.key }); } catch {}
          continue;
        }

        const settings = isGroup ? getGroupSettings(groupId) : {};

        // Trial automático
        if (isGroup && !subscriptions[groupId] && !blacklist[sender]) {
          const senderNum = sender.split('@')[0];
          if (!groupOrNumberHasHistory(groupId, senderNum)) {
            subscriptions[groupId] = {
              type: 'trial',
              activatedAt: Date.now(),
              expiresAt: Date.now() + (10 * 60 * 1000),
              notified: false
            };
            saveDB('subscriptions', subscriptions);
            markGroupHistory(groupId, 'trial', senderNum);
            
            await sock.sendMessage(groupId, {
              text: `🎉 *Teste Grátis Ativado!*\n\n⏰ Duração: 10 minutos\n\nApos o teste, entre em contato:\nwa.me/${OWNER_NUMBER}`,
            });
          }
        }

        // Obter texto
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
                  caption: `👁️ Visualização única de @${sender.split('@')[0]} revelada:`,
                }, { mentions: [sender] });
              }
            } catch {}
          }
          continue;
        }

        // Antilink
        if (isGroup && settings.antilink && body) {
          const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
          const urls = body.match(urlRegex);
          if (urls) {
            const allowed = settings.antilinkAllow || [];
            const hasBlocked = urls.some(url => !allowed.some(a => url.includes(a)));
            if (hasBlocked) {
              const isAdminSender = await isAdmin(sock, groupId, sender);
              if (!isAdminSender && !isOwner(sender)) {
                try { await sock.sendMessage(groupId, { delete: message.key }); } catch {}
                await sock.sendMessage(groupId, {
                  text: `⚠️ @${sender.split('@')[0]}, links não são permitidos!`,
                  mentions: [sender],
                });
                continue;
              }
            }
          }
        }

        // Anti palavrões
        if (isGroup && settings.antiPalavra && body && settings.palavroes?.length) {
          const lower = body.toLowerCase();
          const found = settings.palavroes.find(p => lower.includes(p));
          if (found) {
            const isAdminSender = await isAdmin(sock, groupId, sender);
            if (!isAdminSender && !isOwner(sender)) {
              try { await sock.sendMessage(groupId, { delete: message.key }); } catch {}
              await sock.sendMessage(groupId, {
                text: `⚠️ @${sender.split('@')[0]}, palavrões não são permitidos!`,
                mentions: [sender],
              });
              continue;
            }
          }
        }

        // Anti vendas
        if (isGroup && settings.antiVendas && body) {
          const vendasPatterns = [
            /R\$\s*\d+/i, /\d+[.,]\d{2}\s*(reais|real)/i, /vendo\b/i, /vende-se/i,
            /à venda/i, /compre\s+(já|agora|aqui)/i, /promoção/i, /oferta\s+(imperdível|especial)/i,
            /por\s+apenas\s+R?\$?\s*\d+/i, /pix\s+.*\d+/i, /entrega\s+(grátis|gratuita)/i,
            /frete\s+(grátis|gratuita|free)/i, /link\s+(na\s+)?bio/i, /chama\s+(no\s+)?(pv|privado|inbox|dm)/i,
          ];
          
          const isVenda = vendasPatterns.some(pattern => pattern.test(body));
          
          if (isVenda) {
            const isAdminSender = await isAdmin(sock, groupId, sender);
            if (!isAdminSender && !isOwner(sender)) {
              try { await sock.sendMessage(groupId, { delete: message.key }); } catch {}
              await sock.sendMessage(groupId, {
                text: `🚫 @${sender.split('@')[0]}, mensagens de venda não são permitidas!\n\nUse #anunciar para anúncios oficiais.`,
                mentions: [sender],
              });
              continue;
            }
          }
        }

        // Só admins
        if (isGroup && settings.soAdm && body) {
          const isAdminSender = await isAdmin(sock, groupId, sender);
          if (!isAdminSender && !isOwner(sender) && !hasCargo(groupId, sender, 'admin', 'mod', 'aux')) {
            try { await sock.sendMessage(groupId, { delete: message.key }); } catch {}
            continue;
          }
        }

        // Verificar AFK
        if (isGroup && body) {
          const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
          for (const uid of mentioned) {
            if (afkList[uid]) {
              const afk = afkList[uid];
              await sock.sendMessage(groupId, {
                text: `💤 @${uid.split('@')[0]} está ausente: "${afk.msg}"`,
                mentions: [uid],
              });
            }
          }
          if (afkList[sender]) {
            const afk = afkList[sender];
            delete afkList[sender];
            saveDB('afkList', afkList);
            await sock.sendMessage(groupId, {
              text: `👋 @${sender.split('@')[0]} voltou! (ausente por ${formatTime(Date.now() - afk.time)})`,
              mentions: [sender],
            });
          }
        }

        // ============================================================
        // MENSAGEM PRIVADA — CONFIGURAÇÃO PROFISSIONAL
        // ============================================================
        if (!isGroup) {
          const privateSender = sender;
          const privateReply = (text) => sock.sendMessage(groupId, { text }, { quoted: message });
          const ownerPrivate = isOwner(privateSender);
          
          if (!privateConfig[privateSender]) {
            privateConfig[privateSender] = { step: 'idle', selectedGroup: null };
          }
          
          const pConfig = privateConfig[privateSender];

          // Menu de configuração do grupo
          const buildConfigMenu = (gId, gName) => {
            const s = getGroupSettings(gId);
            const sub = checkSubscription(gId);
            const subInfo = sub.active
              ? `✅ Ativa | Expira: ${formatTime(sub.expiresAt - Date.now())}`
              : '❌ Inativa';
            
            const cmdCount = customCmds[gId] ? Object.keys(customCmds[gId]).length : 0;
            const schedCount = autoMessages[gId] ? Object.keys(autoMessages[gId]).length : 0;
            const productCount = shop[gId] ? Object.keys(shop[gId]).length : 0;

            let menu = `
╔═══════════════════════════════╗
   ⚙️ *PAINEL DE CONFIGURAÇÃO*
╚═══════════════════════════════╝

📍 *Grupo:* ${gName}
📊 *Assinatura:* ${subInfo}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
   🔧 *FUNÇÕES* (envie o número)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
1️⃣ Antilink         ${s.antilink ? '✅' : '❌'}
2️⃣ Bem-vindo        ${s.welcome ? '✅' : '❌'}
3️⃣ Anti Palavrão    ${s.antiPalavra ? '✅' : '❌'}
4️⃣ Anti Vendas      ${s.antiVendas ? '✅' : '❌'}
5️⃣ Só Admin         ${s.soAdm ? '✅' : '❌'}
6️⃣ Anti View Once   ${s.antiViewOnce ? '✅' : '❌'}
7️⃣ Loja             ${s.shopEnabled !== false ? '✅' : '❌'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
   📝 *MENSAGENS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
➤ *bemvindo* [msg] — Texto boas-vindas
➤ *saida* [msg] — Texto de saída
➤ *regras* [texto] — Definir regras

━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ⏰ *AGENDAMENTOS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 Total: ${schedCount} agendamento(s)
➤ *veragenda* — Ver agendamentos
➤ *agenda* [tempo] [texto]
   Ex: agenda 30m Lembrete
   Ex: agenda 2h Bom dia
   Ex: agenda 08:00 Msg diária
➤ *delagenda* [id]

━━━━━━━━━━━━━━━━━━━━━━━━━━━
   🛒 *LOJA*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Produtos: ${productCount}
➤ *anunciar* [nome] | [preço] | [desc]
➤ *verprodutos* — Ver produtos
➤ *delproduto* [id]

━━━━━━━━━━━━━━━━━━━━━━━━━━━
   📋 *COMANDOS PERSONALIZADOS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 Total: ${cmdCount} comando(s)
➤ *vercmd* — Ver comandos
➤ *addcmd* [nome] [texto]
➤ *delcmd* [nome]

━━━━━━━━━━━━━━━━━━━━━━━━━━━
   🔀 *NAVEGAÇÃO*
━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

            if (ownerPrivate) {
              menu += `
➤ *plano* — Gerenciar assinatura
➤ *stats* — Estatísticas`;
            }

            menu += `
➤ *trocar* — Mudar de grupo
➤ *menu* — Exibir este menu
➤ *sair* — Encerrar

╔═══════════════════════════════╗
        ⚡ *SignaBOT* v2.0 ⚡
╚═══════════════════════════════╝`;
            return menu;
          };
          
          // Seleção de grupo
          if (pConfig.step === 'awaiting_group_selection' && /^\d+$/.test(body.trim())) {
            const idx = parseInt(body.trim()) - 1;
            const groups = pConfig.adminGroups || [];
            
            if (idx >= 0 && idx < groups.length) {
              const selectedGroup = groups[idx];
              pConfig.step = 'configuring';
              pConfig.selectedGroup = selectedGroup.id;
              pConfig.selectedGroupName = selectedGroup.name;
              saveDB('privateConfig', privateConfig);
              
              await privateReply(buildConfigMenu(selectedGroup.id, selectedGroup.name));
              continue;
            } else {
              await privateReply('❌ Opção inválida. Envie o número do grupo.');
              continue;
            }
          }
          
          // Modo configuração ativo
          if (pConfig.step === 'configuring' && pConfig.selectedGroup) {
            const input = body.trim().toLowerCase();
            const rawInput = body.trim();
            const selectedGroupId = pConfig.selectedGroup;
            const selectedGroupName = pConfig.selectedGroupName || 'Grupo';
            const settings = getGroupSettings(selectedGroupId);
            
            if (input === 'sair' || input === 'exit') {
              pConfig.step = 'idle';
              pConfig.selectedGroup = null;
              saveDB('privateConfig', privateConfig);
              await privateReply('✅ Configuração encerrada!');
              continue;
            }
            
            if (input === 'menu') {
              await privateReply(buildConfigMenu(selectedGroupId, selectedGroupName));
              continue;
            }
            
            if (input === 'trocar') {
              pConfig.step = 'idle';
              pConfig.selectedGroup = null;
              saveDB('privateConfig', privateConfig);
            }
            
            // Toggle funções
            const toggleMap = {
              '1': { key: 'antilink', name: 'Antilink' },
              '2': { key: 'welcome', name: 'Bem-vindo' },
              '3': { key: 'antiPalavra', name: 'Anti Palavrão' },
              '4': { key: 'antiVendas', name: 'Anti Vendas' },
              '5': { key: 'soAdm', name: 'Só Admin' },
              '6': { key: 'antiViewOnce', name: 'Anti View Once' },
              '7': { key: 'shopEnabled', name: 'Loja' },
            };
            
            if (toggleMap[input]) {
              const opt = toggleMap[input];
              settings[opt.key] = !settings[opt.key];
              saveSettings();
              const status = settings[opt.key] ? '✅ ATIVADO' : '❌ DESATIVADO';
              await privateReply(`${opt.name}: ${status}`);
              continue;
            }
            
            // Boas-vindas
            if (input.startsWith('bemvindo ')) {
              const msg = rawInput.substring(rawInput.indexOf(' ') + 1);
              settings.welcomeMsg = msg;
              saveSettings();
              await privateReply(`✅ Mensagem de boas-vindas definida:\n\n${msg}`);
              continue;
            }
            
            // Saída
            if (input.startsWith('saida ')) {
              const msg = rawInput.substring(rawInput.indexOf(' ') + 1);
              settings.leaveMsg = msg;
              saveSettings();
              await privateReply(`✅ Mensagem de saída definida:\n\n${msg}`);
              continue;
            }
            
            // Regras
            if (input.startsWith('regras ')) {
              const msg = rawInput.substring(rawInput.indexOf(' ') + 1);
              rules[selectedGroupId] = msg;
              saveDB('rules', rules);
              await privateReply(`✅ Regras definidas:\n\n${msg}`);
              continue;
            }
            
            // Ver comandos
            if (input === 'vercmd') {
              const cmds = customCmds[selectedGroupId];
              if (!cmds || !Object.keys(cmds).length) {
                await privateReply('📋 Nenhum comando personalizado.');
                continue;
              }
              let text = `*📋 Comandos — ${selectedGroupName}:*\n\n`;
              Object.entries(cmds).forEach(([name, cmd], i) => {
                const hasImg = cmd.imagePath ? '📷' : '';
                const preview = cmd.text ? cmd.text.substring(0, 30) + '...' : '';
                text += `${i + 1}. #${name} ${hasImg} ${preview}\n`;
              });
              await privateReply(text);
              continue;
            }
            
            // Adicionar comando
            if (input.startsWith('addcmd ')) {
              const parts = rawInput.substring(7).split(/\s+/);
              const cmdName = parts[0]?.toLowerCase();
              const cmdText = parts.slice(1).join(' ');
              if (!cmdName || !cmdText) {
                await privateReply('❌ Use: addcmd [nome] [texto]');
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
              await privateReply(`✅ Comando #${cmdName} criado!`);
              continue;
            }
            
            // Deletar comando
            if (input.startsWith('delcmd ')) {
              const cmdName = input.replace('delcmd ', '').trim();
              if (!customCmds[selectedGroupId]?.[cmdName]) {
                await privateReply('❌ Comando não encontrado.');
                continue;
              }
              if (customCmds[selectedGroupId][cmdName].imagePath) {
                try { fs.unlinkSync(customCmds[selectedGroupId][cmdName].imagePath); } catch {}
              }
              delete customCmds[selectedGroupId][cmdName];
              saveDB('customCmds', customCmds);
              await privateReply(`✅ Comando #${cmdName} deletado!`);
              continue;
            }
            
            // Ver agendamentos
            if (input === 'veragenda') {
              const scheds = autoMessages[selectedGroupId];
              if (!scheds || !Object.keys(scheds).length) {
                await privateReply('📅 Nenhum agendamento.');
                continue;
              }
              let text = `*📅 Agendamentos — ${selectedGroupName}:*\n\n`;
              Object.entries(scheds).forEach(([id, s], i) => {
                const preview = s.text.substring(0, 40) + '...';
                if (s.type === 'once') {
                  text += `${i + 1}. ${id}\n   ⏰ ${new Date(s.executeAt).toLocaleString('pt-BR')}\n   📝 ${preview}\n\n`;
                } else {
                  text += `${i + 1}. ${id}\n   ⏰ ${s.time} | Dias: ${s.days}\n   📝 ${preview}\n\n`;
                }
              });
              await privateReply(text);
              continue;
            }
            
            // Agendar mensagem
            if (input.startsWith('agenda ')) {
              const parts = rawInput.substring(7).trim();
              const firstSpace = parts.indexOf(' ');
              if (firstSpace === -1) {
                await privateReply('❌ Use: agenda [tempo] [texto]\nEx: agenda 30m Lembrete');
                continue;
              }
              
              const timeArg = parts.substring(0, firstSpace).toLowerCase();
              const msgText = parts.substring(firstSpace + 1);
              
              let scheduleType = '';
              let executeAt = 0;
              let repeatTime = null;
              let repeatDays = 'todos';
              
              if (timeArg.endsWith('m') && /^\d+m$/.test(timeArg)) {
                const minutes = parseInt(timeArg.replace('m', ''));
                scheduleType = 'once';
                executeAt = Date.now() + (minutes * 60 * 1000);
              } else if (timeArg.endsWith('h') && /^\d+h$/.test(timeArg)) {
                const hours = parseInt(timeArg.replace('h', ''));
                scheduleType = 'once';
                executeAt = Date.now() + (hours * 60 * 60 * 1000);
              } else if (/^\d{2}:\d{2}$/.test(timeArg)) {
                scheduleType = 'daily';
                repeatTime = timeArg;
              } else {
                await privateReply('❌ Formato inválido. Use: 30m, 2h ou 08:00');
                continue;
              }
              
              const schedId = 'SCH_' + Date.now().toString(36).toUpperCase();
              if (!autoMessages[selectedGroupId]) autoMessages[selectedGroupId] = {};
              autoMessages[selectedGroupId][schedId] = {
                type: scheduleType,
                time: repeatTime,
                executeAt,
                days: repeatDays,
                text: msgText,
                active: true,
                creator: privateSender,
                createdAt: Date.now()
              };
              saveDB('autoMessages', autoMessages);
              
              let confirmMsg = `✅ Agendado!\n\n🆔 ${schedId}\n`;
              if (scheduleType === 'once') {
                confirmMsg += `⏰ ${new Date(executeAt).toLocaleString('pt-BR')}`;
              } else {
                confirmMsg += `⏰ ${repeatTime} (diário)`;
              }
              
              await privateReply(confirmMsg);
              continue;
            }
            
            // Deletar agendamento
            if (input.startsWith('delagenda ')) {
              const schedId = input.replace('delagenda ', '').trim().toUpperCase();
              if (!autoMessages[selectedGroupId]?.[schedId]) {
                await privateReply('❌ Agendamento não encontrado.');
                continue;
              }
              delete autoMessages[selectedGroupId][schedId];
              saveDB('autoMessages', autoMessages);
              await privateReply(`✅ Agendamento ${schedId} removido!`);
              continue;
            }
            
            // Anunciar produto (pelo privado)
            if (input.startsWith('anunciar ')) {
              const content = rawInput.substring(9);
              const parts = content.split('|').map(p => p.trim());
              
              if (parts.length < 2) {
                await privateReply('❌ Use: anunciar [nome] | [preço] | [descrição]');
                continue;
              }
              
              const productId = 'PRD_' + Date.now().toString(36).toUpperCase();
              if (!shop[selectedGroupId]) shop[selectedGroupId] = {};
              shop[selectedGroupId][productId] = {
                name: parts[0] || 'Sem nome',
                price: parts[1] || 'Sob consulta',
                description: parts[2] || '',
                imagePath: null,
                seller: privateSender,
                sellerName: message.pushName || privateSender.split('@')[0],
                createdAt: Date.now()
              };
              saveDB('shop', shop);
              
              await privateReply(`✅ Produto anunciado!\n\n🆔 ${productId}\n📦 ${parts[0]}\n💰 ${parts[1]}\n\nO anúncio será exibido no grupo.`);
              
              // Enviar anúncio no grupo
              const anuncio = `
╔══════════════════════════╗
   🏷️ *ANÚNCIO ESPECIAL* 🏷️
╚══════════════════════════╝

🛍️ *${parts[0]}*
💰 *Preço:* ${parts[1]}

📝 ${parts[2] || 'Sem descrição'}

👤 *Vendedor:* @${privateSender.split('@')[0]}
🆔 ${productId}

╔══════════════════════════╗
      🛒 *LOJA SignaBOT* 🛒
╚══════════════════════════╝`;
              
              await sock.sendMessage(selectedGroupId, {
                text: anuncio,
                mentions: [privateSender]
              });
              
              continue;
            }
            
            // Ver produtos
            if (input === 'verprodutos') {
              const products = shop[selectedGroupId];
              if (!products || !Object.keys(products).length) {
                await privateReply('📦 Nenhum produto anunciado.');
                continue;
              }
              let text = `*📦 Produtos — ${selectedGroupName}:*\n\n`;
              Object.entries(products).forEach(([id, p], i) => {
                text += `${i + 1}. ${p.name} — ${p.price}\n   🆔 ${id}\n\n`;
              });
              await privateReply(text);
              continue;
            }
            
            // Deletar produto
            if (input.startsWith('delproduto ')) {
              const productId = input.replace('delproduto ', '').trim().toUpperCase();
              if (!shop[selectedGroupId]?.[productId]) {
                await privateReply('❌ Produto não encontrado.');
                continue;
              }
              if (shop[selectedGroupId][productId].imagePath) {
                try { fs.unlinkSync(shop[selectedGroupId][productId].imagePath); } catch {}
              }
              delete shop[selectedGroupId][productId];
              saveDB('shop', shop);
              await privateReply(`✅ Produto ${productId} removido!`);
              continue;
            }
            
            // Plano (dono)
            if (input === 'plano' && ownerPrivate) {
              const sub = checkSubscription(selectedGroupId);
              let text = `*📊 Assinatura — ${selectedGroupName}*\n\n`;
              if (sub.active) {
                text += `Status: ✅ Ativa\n`;
                text += `Tipo: ${subscriptions[selectedGroupId]?.type || 'premium'}\n`;
                text += `Expira: ${new Date(sub.expiresAt).toLocaleString('pt-BR')}\n`;
                text += `Restante: ${formatTime(sub.expiresAt - Date.now())}\n`;
              } else {
                text += `Status: ❌ Inativa\n`;
              }
              text += `\n*Ações:*\n➤ ativar [dias] — Ativar plano\n➤ cancelar — Cancelar`;
              await privateReply(text);
              continue;
            }
            
            // Ativar plano (dono)
            if (input.startsWith('ativar ') && ownerPrivate) {
              const dias = parseInt(input.replace('ativar ', '').trim());
              if (!dias || dias < 1 || dias > 365) {
                await privateReply('❌ Use: ativar [dias] (1-365)');
                continue;
              }
              subscriptions[selectedGroupId] = {
                type: 'premium',
                expiresAt: Date.now() + (dias * 86400000),
                activatedBy: privateSender,
                activatedAt: Date.now()
              };
              saveDB('subscriptions', subscriptions);
              await privateReply(`✅ ${dias} dias ativados para ${selectedGroupName}!`);
              continue;
            }
            
            // Cancelar plano (dono)
            if (input === 'cancelar' && ownerPrivate) {
              if (!subscriptions[selectedGroupId]) {
                await privateReply('❌ Sem assinatura ativa.');
                continue;
              }
              delete subscriptions[selectedGroupId];
              saveDB('subscriptions', subscriptions);
              await privateReply(`✅ Assinatura de ${selectedGroupName} cancelada.`);
              continue;
            }
            
            // Stats (dono)
            if (input === 'stats' && ownerPrivate) {
              const activity = userActivity[selectedGroupId] || {};
              const members = Object.keys(activity).length;
              let totalMsgs = 0;
              for (const data of Object.values(activity)) {
                totalMsgs += data.messageCount || 0;
              }
              const cmdsCount = customCmds[selectedGroupId] ? Object.keys(customCmds[selectedGroupId]).length : 0;
              const schedsCount = autoMessages[selectedGroupId] ? Object.keys(autoMessages[selectedGroupId]).length : 0;
              const productsCount = shop[selectedGroupId] ? Object.keys(shop[selectedGroupId]).length : 0;
              
              await privateReply(`*📊 Estatísticas — ${selectedGroupName}*\n\n👥 Membros ativos: ${members}\n💬 Total mensagens: ${totalMsgs}\n📝 Comandos: ${cmdsCount}\n📅 Agendamentos: ${schedsCount}\n📦 Produtos: ${productsCount}`);
              continue;
            }
          }
          
          // Detecção de admin e listagem de grupos
          if (pConfig.step === 'idle' || !pConfig.step) {
            try {
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
              
              // Dono do bot: mostrar todos
              if (ownerPrivate) {
                const allGroupsList = Object.entries(allGroups).map(([gId, g]) => {
                  const sub = checkSubscription(gId);
                  return {
                    id: gId,
                    name: g.subject,
                    role: 'Dono',
                    subStatus: sub.active ? '✅' : '❌',
                    members: g.participants?.length || 0
                  };
                });
                
                if (allGroupsList.length) {
                  pConfig.step = 'awaiting_group_selection';
                  pConfig.adminGroups = allGroupsList;
                  saveDB('privateConfig', privateConfig);
                  
                  let text = `
╔═══════════════════════════════╗
   👑 *PAINEL DO DONO — SignaBOT*
╚═══════════════════════════════╝

Olá, *${message.pushName || 'Dono'}*!

📊 *Resumo:*
➤ Total de grupos: ${allGroupsList.length}
➤ Assinaturas ativas: ${allGroupsList.filter(g => g.subStatus === '✅').length}

━━━━━━━━━━━━━━━━━━━━━━━━━━━
   📋 *GRUPOS*
━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
                  allGroupsList.forEach((g, i) => {
                    text += `*${i + 1}.* ${g.name}\n   ${g.subStatus} | ${g.members} membros\n\n`;
                  });
                  
                  text += `\nEnvie o *número* do grupo para configurar.`;
                  
                  await privateReply(text);
                  continue;
                }
              }
              
              // Admin normal
              if (adminGroups.length > 0) {
                pConfig.step = 'awaiting_group_selection';
                pConfig.adminGroups = adminGroups;
                saveDB('privateConfig', privateConfig);
                
                let text = `
╔═══════════════════════════════╗
   ⚙️ *PAINEL DE ADMIN — SignaBOT*
╚═══════════════════════════════╝

Olá, *${message.pushName || 'Admin'}*!
Você é admin em *${adminGroups.length} grupo(s)*:

━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
                adminGroups.forEach((g, i) => {
                  const sub = checkSubscription(g.id);
                  const subStatus = sub.active ? '✅' : '❌';
                  text += `*${i + 1}.* ${g.name}\n   ${g.role} | Assinatura: ${subStatus}\n\n`;
                });
                
                text += `\nEnvie o *número* do grupo para configurar.`;
                
                await privateReply(text);
                continue;
              } else {
                await privateReply(`
Olá, *${message.pushName || 'Usuário'}*!

❌ Você não é administrador de nenhum grupo com o SignaBOT.

*Para usar o SignaBOT:*
1. Assine um plano
2. Adicione o bot ao seu grupo
3. Torne o bot admin

*Planos:*
➤ 7 dias — R$ 5,00
➤ 30 dias — R$ 10,00
➤ 60 dias — R$ 15,00
➤ 90 dias — R$ 20,00

*Contato:* wa.me/${OWNER_NUMBER}`);
                continue;
              }
            } catch (err) {
              console.log('[PRIVADO] Erro:', err.message);
              logBotError('private_detection', err);
              await privateReply('❌ Erro ao processar. Tente novamente.');
              continue;
            }
          }
        }

        // Processar comandos
        if (body && PREFIXES.some(p => body.startsWith(p))) {
          const parts = body.trim().split(/\s+/);
          const rawCommand = parts[0].toLowerCase();
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
        console.log('[SignaBot] Erro: ' + err.message);
        logBotError('messages.upsert', err);
      }
    }
  });

  // Verificar assinaturas e agendamentos a cada minuto
  setInterval(async () => {
    const now = Date.now();
    
    // Verificar assinaturas expiradas
    for (const [groupId, sub] of Object.entries(subscriptions)) {
      if (sub.expiresAt < now && !sub.notified) {
        try {
          markGroupHistory(groupId, sub.type || 'paid', null);
          await sock.sendMessage(groupId, {
            text: `⚠️ *Assinatura Expirada*\n\nO ${sub.type === 'trial' ? 'teste grátis' : 'plano'} expirou.\n\nContato: wa.me/${OWNER_NUMBER}`,
          });
          subscriptions[groupId].notified = true;
          saveDB('subscriptions', subscriptions);
        } catch {}
      }
    }
    
    // Verificar agendamentos
    const currentTime = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const currentDay = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'][new Date().getDay()];
    
    for (const [groupId, scheds] of Object.entries(autoMessages)) {
      for (const [schedId, sched] of Object.entries(scheds)) {
        if (!sched.active) continue;
        
        // Agendamento único (por minutos/horas)
        if (sched.type === 'once' && sched.executeAt && sched.executeAt <= now) {
          try {
            await sock.sendMessage(groupId, { text: sched.text });
            // Marcar como executado
            sched.active = false;
            sched.executedAt = now;
            saveDB('autoMessages', autoMessages);
          } catch (err) {
            console.log('[SCHEDULE] Erro:', err.message);
          }
        }
        
        // Agendamento diário (horário fixo)
        if (sched.type === 'daily' && sched.time === currentTime) {
          // Verificar dia da semana
          const days = sched.days || 'todos';
          if (days !== 'todos' && !days.includes(currentDay)) continue;
          
          // Evitar enviar múltiplas vezes no mesmo minuto
          const lastSent = sched.lastSent || 0;
          if (now - lastSent < 60000) continue;
          
          try {
            await sock.sendMessage(groupId, { text: sched.text });
            sched.lastSent = now;
            saveDB('autoMessages', autoMessages);
          } catch (err) {
            console.log('[SCHEDULE] Erro:', err.message);
          }
        }
      }
    }
  }, 60000);

  // Eventos de grupo (entrar/sair)
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

        let welcomeText = settings.welcomeMsg ||
          `🎉 Bem-vindo(a) ao grupo, @${participant.split('@')[0]}!\n\nDigite *#menu* para ver os comandos.`;

        try {
          const meta = await sock.groupMetadata(groupId);
          welcomeText = replaceVars(welcomeText, {
            user: `@${participant.split('@')[0]}`,
            group: meta.subject || 'o grupo',
            desc: meta.desc || '',
            numero: participant.split('@')[0],
            membros: String(meta.participants.length),
          });
        } catch {}

        try {
          await sock.sendMessage(groupId, {
            text: welcomeText,
            mentions: [participant],
          });
        } catch {}
      }
    }

    if (action === 'remove' && settings.leaveMsg) {
      for (const participant of participants) {
        try {
          await sock.sendMessage(groupId, {
            text: settings.leaveMsg.replace(/@user|{user}/gi, `@${participant.split('@')[0]}`),
            mentions: [participant],
          });
        } catch {}
      }
    }
  });

  return sock;
};

// Iniciar bot
connectBot().catch(err => {
  console.log('[SignaBot] Erro fatal: ' + err.message);
  setTimeout(() => connectBot(), 10000);
});
