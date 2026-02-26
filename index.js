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

// ============================================================
// SIGNABOT - Bot WhatsApp Completo
// ============================================================

const PREFIX = '#';
const PREFIX2 = '/';
const BOT_NAME = 'SignaBot';
const OWNER_NUMBER = '5592999652961'; // SEU NÚMERO AQUI
const BOT_NUMBER = '557183477259'; // Número do bot que aparece nos logs

// Lista de JIDs que são considerados donos
const OWNER_JIDS = [
  `${OWNER_NUMBER}@s.whatsapp.net`,
  `${BOT_NUMBER}@s.whatsapp.net`,
  '212171434754106@lid', // Formato que aparece nos logs
  '5592999652961@s.whatsapp.net'
];

// ========== FUNÇÃO ISOWNER CORRIGIDA ==========
const isOwner = (sender) => {
  // Verificar se o sender está na lista de JIDs do dono
  const isInList = OWNER_JIDS.includes(sender);
  
  // Extrair apenas números do sender
  let senderNumber = sender.split('@')[0];
  senderNumber = senderNumber.replace(/\D/g, '');
  
  // Números para comparação
  const ownerNumber = OWNER_NUMBER.replace(/\D/g, '');
  const botNumber = BOT_NUMBER.replace(/\D/g, '');
  
  // Verificar se o número corresponde
  const isNumberMatch = senderNumber === ownerNumber || senderNumber === botNumber;
  
  // Log para debug
  console.log(`[DEBUG] Verificando dono:`);
  console.log(`[DEBUG] Sender original: ${sender}`);
  console.log(`[DEBUG] Sender número: ${senderNumber}`);
  console.log(`[DEBUG] Dono número: ${ownerNumber}`);
  console.log(`[DEBUG] Bot número: ${botNumber}`);
  console.log(`[DEBUG] Na lista? ${isInList}`);
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
  if (!fs.existsSync(file)) { 
    fs.writeFileSync(file, '{}'); 
    return {}; 
  }
  try { 
    return JSON.parse(fs.readFileSync(file, 'utf8')); 
  } catch { 
    return {}; 
  }
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
  } catch { 
    return false; 
  }
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
  } catch { 
    return null; 
  }
};

// ============================================================
// HANDLER DE COMANDOS
// ============================================================

const handleCommand = async (sock, message, groupId, sender, command, args, isGroup) => {
  const senderName = message.pushName || sender.split('@')[0];
  const reply = (text) => sock.sendMessage(groupId, { text }, { quoted: message });
  const adminCheck = isGroup ? await isAdmin(sock, groupId, sender) : false;
  const ownerCheck = isOwner(sender);
  const cargoCheck = (groupId, ...c) => ownerCheck || adminCheck || hasCargo(groupId, sender, ...c);

  // Log do comando
  console.log(`[COMANDO] ${command} de ${sender} no grupo ${groupId}`);
  console.log(`[OWNER] É dono? ${ownerCheck}`);

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
  // ASSINATURA (dono)
  // ===========================================================

  if (command === '!ativar') {
    console.log(`[!ATIVAR] Executando comando de ativação`);
    
    if (!ownerCheck) {
      console.log(`[!ATIVAR] NEGADO - Não é o dono`);
      return reply('❌ Sem permissao.');
    }
    
    if (!isGroup) return reply('Use em um grupo.');
    
    const days = parseInt(args[0]);
    if (![7, 15, 30, 60, 90].includes(days)) return reply('Use: !ativar [7|15|30|60|90] dias');
    
    const expiresAt = Date.now() + days * 86400000;
    subscriptions[groupId] = { type: 'paid', activatedAt: Date.now(), expiresAt, days };
    saveDB('subscriptions', subscriptions);
    
    console.log(`[!ATIVAR] Assinatura ativada para ${groupId} até ${new Date(expiresAt).toLocaleString('pt-BR')}`);
    
    return reply(`✅ Assinatura ativada por ${days} dias!\nExpira em: ${new Date(expiresAt).toLocaleString('pt-BR')}`);
  }

  if (command === '!trial') {
    if (!ownerCheck) return reply('❌ Sem permissao.');
    if (!isGroup) return reply('Use em um grupo.');
    const mins = parseInt(args[0]) || 10;
    subscriptions[groupId] = { type: 'trial', activatedAt: Date.now(), expiresAt: Date.now() + mins * 60000 };
    saveDB('subscriptions', subscriptions);
    return reply(`✅ Teste de ${mins} minuto(s) ativado!`);
  }

  if (command === '!cancelar') {
    if (!ownerCheck) return reply('❌ Sem permissao.');
    delete subscriptions[groupId];
    saveDB('subscriptions', subscriptions);
    return reply('✅ Assinatura cancelada.');
  }

  if (command === '!status' || command === '#status') {
    if (!isGroup) return reply('Use em um grupo.');
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

    if (!sub) {
      return reply(`*${BOT_NAME} - Menu Principal*\n\nEscolha um submenu:\n\n${PREFIX}menu figurinhas\n${PREFIX}menu brincadeiras\n${PREFIX}menu efeitos\n${PREFIX}menu adm\n${PREFIX}menu download\n${PREFIX}menu info\n${PREFIX}menu grupo\n${PREFIX}menu gold\n\nInfo:\n${PREFIX}ping - Latencia\n${PREFIX}dono - Contato\n!status - Assinatura`);
    }

    if (sub === 'figurinhas') {
      return reply(`📦 *Menu Figurinhas*\n\n${PREFIX}sticker - Imagem/video para figurinha\n${PREFIX}toimg - Figurinha para imagem\n${PREFIX}take [autor] [pack] - Renomear figurinha\n${PREFIX}togif - Figurinha para GIF\n${PREFIX}tomp4 - Figurinha para video\n${PREFIX}ttp [texto] - Texto para figurinha\n${PREFIX}fig - Criar figurinha`);
    }

    if (sub === 'download') {
      return reply(`📥 *Menu Download*\n\n${PREFIX}play [nome/url] - Audio do YouTube\n${PREFIX}playvideo [nome/url] - Video do YouTube\n${PREFIX}ytmp4 [url] - YouTube MP4\n${PREFIX}tiktok [url] - Baixar TikTok\n${PREFIX}instagram [url] - Baixar Instagram\n${PREFIX}pinterest [busca] - Imagens Pinterest\n${PREFIX}spotify [nome] - Buscar no Spotify\n${PREFIX}letra [musica] - Letra da musica\n${PREFIX}autobaixar [on/off] - Auto-baixar links`);
    }

    if (sub === 'adm') {
      if (!cargoCheck(groupId, 'admin', 'mod')) return reply('Sem permissao para ver este menu.');
      return reply(`👑 *Menu ADM*\n\n${PREFIX}ban @user - Banir\n${PREFIX}add [num] - Adicionar membro\n${PREFIX}promover @user - Promover a admin\n${PREFIX}rebaixar @user - Remover admin\n${PREFIX}cargo @user [admin|mod|aux] - Atribuir cargo\n${PREFIX}advertir @user [motivo] - Advertir\n${PREFIX}checkwarnings @user - Ver adv.\n${PREFIX}removewarnings @user - Remover adv.\n${PREFIX}marcar [texto] - Marcar todos\n${PREFIX}bemvindo [on/off] - Boas-vindas\n${PREFIX}antilink [on/off] - Antilink\n${PREFIX}fechargp - Fechar grupo\n${PREFIX}abrirgp - Abrir grupo\n${PREFIX}banghost - Banir fantasmas\n${PREFIX}inativos [dias] - Ver inativos\n${PREFIX}nomegp [nome] - Mudar nome\n${PREFIX}descgp [desc] - Mudar descricao\n${PREFIX}linkgp - Link do grupo\n${PREFIX}regras [texto] - Definir regras\n${PREFIX}deletar - Apagar msg marcada\n${PREFIX}so_adm [on/off] - Apenas admins\n${PREFIX}antipalavra [on/off]\n${PREFIX}addpalavra [palavra] - Adicionar palavrao\n${PREFIX}listapalavrao - Ver palavroes\n${PREFIX}ausente [texto] - Modo ausente\n${PREFIX}ativo - Voltar de ausente`);
    }

    if (sub === 'brincadeiras') {
      return reply(`🎮 *Menu Brincadeiras*\n\n${PREFIX}ppt - Pedra Papel Tesoura\n${PREFIX}porcentagem [texto] - Calcular %\n${PREFIX}chance [texto] - Calcular chance\n${PREFIX}dado [lados] - Rolar dado\n${PREFIX}rankgay - Ranking gay\n${PREFIX}rankgado - Ranking gado\n${PREFIX}8ball [pergunta] - Bola magica\n${PREFIX}fakemsg @user [texto] - Mensagem falsa\n${PREFIX}casal - Sortear casal`);
    }

    if (sub === 'grupo') {
      return reply(`👥 *Menu Grupo*\n\n${PREFIX}rankativos - Top 10 mais ativos\n${PREFIX}inativos [dias] - Membros inativos\n${PREFIX}gpinfo - Info do grupo\n${PREFIX}admins - Lista de admins\n${PREFIX}regras - Ver regras do grupo\n${PREFIX}aniversario [dia/mes] - Cadastrar aniversario\n${PREFIX}feedback [texto] - Enviar feedback`);
    }

    if (sub === 'info') {
      return reply(`ℹ️ *Menu Info*\n\n${PREFIX}info - Info do bot\n${PREFIX}dono - Contato do dono\n${PREFIX}ping - Latencia\n${PREFIX}sender - Seu numero\n${PREFIX}imc [peso] [altura] - Calcular IMC\n${PREFIX}calculadora [expr] - Calcular\n${PREFIX}cep [cep] - Buscar CEP\n${PREFIX}signo [data DD/MM] - Ver signo\n${PREFIX}wikipedia [busca] - Buscar na Wikipedia\n${PREFIX}clima [cidade] - Clima atual`);
    }

    return reply('Submenu nao encontrado. Use #menu para ver os disponiveis.');
  }

  // ===========================================================
  // INFO / UTILITARIOS
  // ===========================================================

  if (command === '#ping') {
    const start = Date.now();
    await reply('🏓 Calculando...');
    return reply(`⚡ Pong! Latencia: ${Date.now() - start}ms`);
  }

  if (command === '#info') {
    return reply(`ℹ️ *${BOT_NAME}*\n\nVersao: 2.0\nStatus: Online\nDono: wa.me/${OWNER_NUMBER}\nPrefixos: # e /\n\nDigite #menu para ver os comandos.`);
  }

  if (command === '#dono') {
    return reply(`👤 Dono do bot:\nwa.me/${OWNER_NUMBER}\n\nPara contratar o ${BOT_NAME} para o seu grupo, entre em contato!`);
  }

  if (command === '#sender') {
    const num = sender.split('@')[0];
    return reply(`📱 Seu numero: +${num}`);
  }

  // ===========================================================
  // FIGURINHAS
  // ===========================================================

  if (command === '#sticker' || command === '#fig') {
    const quoted = getQuoted(message);
    const targetMsg = quoted?.imageMessage || quoted?.videoMessage
      || message.message?.imageMessage || message.message?.videoMessage;

    if (!targetMsg) return reply('❌ Marque uma imagem ou video para criar a figurinha!');

    try {
      const type = targetMsg === message.message?.imageMessage || quoted?.imageMessage ? 'image' : 'video';
      const buffer = await downloadMedia(targetMsg, type);
      if (!buffer) return reply('❌ Erro ao baixar midia.');
      await sock.sendMessage(groupId, { sticker: buffer }, { quoted: message });
    } catch (err) { 
      return reply('❌ Erro ao criar figurinha: ' + err.message); 
    }
    return;
  }

  if (command === '#toimg') {
    const quoted = getQuoted(message);
    const stickerMsg = quoted?.stickerMessage || message.message?.stickerMessage;
    if (!stickerMsg) return reply('❌ Marque uma figurinha para converter em imagem!');
    try {
      const buffer = await downloadMedia(stickerMsg, 'sticker');
      if (!buffer) return reply('❌ Erro ao baixar figurinha.');
      await sock.sendMessage(groupId, { image: buffer, caption: 'Imagem convertida' }, { quoted: message });
    } catch (err) { 
      return reply('❌ Erro: ' + err.message); 
    }
    return;
  }

  // ===========================================================
  // DOWNLOADS
  // ===========================================================

  if (command === '#play' || command === '#ytmp3') {
    if (args.length === 0) return reply('❌ Use: #play [nome ou URL da musica]');
    const query = args.join(' ');
    await reply('🔍 Buscando: ' + query + '...');
    try {
      const results = await yts(query);
      const video = results.videos[0];
      if (!video) return reply('❌ Nenhum resultado encontrado.');

      await reply(`🎵 Encontrado: *${video.title}*\n⏱️ Duracao: ${video.timestamp}\n⏳ Baixando audio...`);

      const apiUrl = `https://api.xteam.xyz/ytdl?url=${encodeURIComponent(video.url)}&type=audio`;
      const { data } = await axios.get(apiUrl, { timeout: 30000 });
      if (!data?.url) return reply('❌ Erro ao obter link de audio.');

      const audioResp = await axios.get(data.url, { responseType: 'arraybuffer', timeout: 60000 });
      const buffer = Buffer.from(audioResp.data);

      await sock.sendMessage(groupId, {
        audio: buffer,
        mimetype: 'audio/mpeg',
        ptt: false,
      }, { quoted: message });

      await sock.sendMessage(groupId, {
        image: { url: video.thumbnail },
        caption: `*${video.title}*\n⏱️ Duracao: ${video.timestamp}\n👁️ Views: ${video.views}`,
      });
    } catch (err) { 
      return reply('❌ Erro ao baixar audio: ' + err.message); 
    }
    return;
  }

  if (command === '#tiktok') {
    if (args.length === 0) return reply('❌ Use: #tiktok [URL do video]');
    const url = args[0];
    await reply('📥 Baixando TikTok...');
    try {
      const { data } = await axios.get(
        `https://api.tiklydown.eu.org/api/download?url=${encodeURIComponent(url)}`,
        { timeout: 20000 }
      );
      if (!data?.video?.noWatermark) return reply('❌ Erro ao obter link do video.');
      const videoResp = await axios.get(data.video.noWatermark, { responseType: 'arraybuffer', timeout: 60000 });
      const buffer = Buffer.from(videoResp.data);
      await sock.sendMessage(groupId, {
        video: buffer,
        caption: data.author?.nickname ? `@${data.author.nickname}` : '',
      }, { quoted: message });
    } catch (err) { 
      return reply('❌ Erro ao baixar TikTok: ' + err.message); 
    }
    return;
  }

  // ===========================================================
  // ADMINISTRACAO
  // ===========================================================

  if (command === '#ban') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('❌ Marque o usuario para banir!');
    try {
      await sock.groupParticipantsUpdate(groupId, [mentioned[0]], 'remove');
      return reply(`✅ Usuario banido com sucesso!`);
    } catch (err) { 
      return reply('❌ Erro ao banir: ' + err.message); 
    }
  }

  if (command === '#add') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    if (!args[0]) return reply('Use: #add [numero com DDI]\nEx: #add 5592999999999');
    const num = args[0].replace(/\D/g, '') + '@s.whatsapp.net';
    try {
      await sock.groupParticipantsUpdate(groupId, [num], 'add');
      return reply('✅ Membro adicionado!');
    } catch (err) { 
      return reply('❌ Erro ao adicionar: ' + err.message); 
    }
  }

  if (command === '#promover') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('❌ Marque o usuario!');
    try {
      await sock.groupParticipantsUpdate(groupId, [mentioned[0]], 'promote');
      return reply('✅ Usuario promovido a admin!');
    } catch (err) { 
      return reply('❌ Erro: ' + err.message); 
    }
  }

  if (command === '#rebaixar') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('❌ Marque o usuario!');
    try {
      await sock.groupParticipantsUpdate(groupId, [mentioned[0]], 'demote');
      return reply('✅ Admin rebaixado!');
    } catch (err) { 
      return reply('❌ Erro: ' + err.message); 
    }
  }

  if (command === '#cargo') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length || !args[1]) return reply('Use: #cargo @usuario [admin|mod|aux|remover]');
    const userId = mentioned[0];
    const novoCargo = args[1].toLowerCase();
    if (!['admin', 'mod', 'aux', 'remover'].includes(novoCargo)) return reply('Cargos validos: admin, mod, aux, remover');
    if (!cargos[groupId]) cargos[groupId] = {};
    if (novoCargo === 'remover') { 
      delete cargos[groupId][userId]; 
    } else { 
      cargos[groupId][userId] = novoCargo; 
    }
    saveDB('cargos', cargos);
    return reply(novoCargo === 'remover' ? '✅ Cargo removido!' : `✅ Cargo "${novoCargo}" atribuido com sucesso!`);
  }

  if (command === '#advertir') {
    if (!cargoCheck(groupId, 'admin', 'mod', 'aux')) return reply('❌ Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('❌ Marque o usuario para advertir!');
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
        await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
        delete warnings[groupId][userId];
        saveDB('warnings', warnings);
        return sock.sendMessage(groupId, {
          text: `🚫 Usuario banido por atingir ${limit} advertencias!\nMotivo: ${motivo}`,
          mentions: [userId],
        });
      } catch (err) { 
        return reply('❌ Erro ao banir apos advertencias: ' + err.message); 
      }
    }
    return sock.sendMessage(groupId, {
      text: `⚠️ Advertencia ${count}/${limit} aplicada!\nMotivo: ${motivo}`,
      mentions: [userId],
    });
  }

  if (command === '#checkwarnings' || command === '#ver_adv') {
    const mentioned = getMentioned(message);
    const userId = mentioned.length ? mentioned[0] : sender;
    const userWarns = warnings[groupId]?.[userId];
    if (!userWarns || !userWarns.length) return reply('✅ Sem advertencias.');
    const limit = settings.warningLimit || 3;
    let text = `⚠️ *Advertencias: ${userWarns.length}/${limit}*\n\n`;
    userWarns.forEach((w, i) => {
      text += `${i + 1}. ${new Date(w.date).toLocaleString('pt-BR')}\nMotivo: ${w.motivo}\n\n`;
    });
    return reply(text);
  }

  if (command === '#removewarnings' || command === '#rm_adv') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    const mentioned = getMentioned(message);
    if (!mentioned.length) return reply('❌ Marque o usuario!');
    const userId = mentioned[0];
    if (warnings[groupId]) delete warnings[groupId][userId];
    saveDB('warnings', warnings);
    return reply('✅ Advertencias removidas!');
  }

  if (command === '#setlimitec') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissao.');
    const num = parseInt(args[0]);
    if (isNaN(num) || num < 1) return reply('Use: #setlimitec [numero]\nEx: #setlimitec 3');
    settings.warningLimit = num;
    saveSettings();
    return reply(`✅ Limite de advertencias definido para ${num}.`);
  }

  if (command === '#marcar' || command === '#tagall') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    try {
      const meta = await sock.groupMetadata(groupId);
      const participants = meta.participants.map(p => p.id);
      const text = args.join(' ') || 'Marcacao geral!';
      await sock.sendMessage(groupId, { text: `📢 *Marcacao Geral*\n\n${text}`, mentions: participants });
    } catch (err) { 
      return reply('❌ Erro: ' + err.message); 
    }
    return;
  }

  if (command === '#deletar' || command === '#del') {
    if (!cargoCheck(groupId, 'admin', 'mod', 'aux')) return reply('❌ Sem permissao.');
    const quoted = getQuoted(message);
    if (!quoted) return reply('❌ Marque a mensagem para deletar!');
    const quotedKey = message.message?.extendedTextMessage?.contextInfo;
    if (!quotedKey) return reply('❌ Nao foi possivel identificar a mensagem.');
    try {
      await sock.sendMessage(groupId, { delete: {
        remoteJid: groupId,
        fromMe: false,
        id: quotedKey.stanzaId,
        participant: quotedKey.participant,
      }});
    } catch { 
      return reply('❌ Nao consegui apagar a mensagem (preciso ser admin).'); 
    }
    return;
  }

  if (command === '#fechargp') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    try {
      await sock.groupSettingUpdate(groupId, 'announcement');
      return reply('🔒 Grupo fechado! Apenas admins podem enviar mensagens.');
    } catch (err) { 
      return reply('❌ Erro: ' + err.message); 
    }
  }

  if (command === '#abrirgp') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    try {
      await sock.groupSettingUpdate(groupId, 'not_announcement');
      return reply('🔓 Grupo aberto! Todos podem enviar mensagens.');
    } catch (err) { 
      return reply('❌ Erro: ' + err.message); 
    }
  }

  if (command === '#linkgp') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    try {
      const code = await sock.groupInviteCode(groupId);
      return reply(`🔗 Link do grupo:\nhttps://chat.whatsapp.com/${code}`);
    } catch (err) { 
      return reply('❌ Erro: ' + err.message); 
    }
  }

  if (command === '#nomegp') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissao.');
    if (!args.length) return reply('Use: #nomegp [novo nome]');
    try {
      await sock.groupUpdateSubject(groupId, args.join(' '));
      return reply('✅ Nome do grupo alterado!');
    } catch (err) { 
      return reply('❌ Erro: ' + err.message); 
    }
  }

  if (command === '#descgp') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissao.');
    if (!args.length) return reply('Use: #descgp [nova descricao]');
    try {
      await sock.groupUpdateDescription(groupId, args.join(' '));
      return reply('✅ Descricao do grupo alterada!');
    } catch (err) { 
      return reply('❌ Erro: ' + err.message); 
    }
  }

  if (command === '#regras') {
    if (!args.length) {
      const r = rules[groupId];
      return reply(r ? `📜 *Regras do grupo:*\n\n${r}` : 'Nenhuma regra definida.');
    }
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    rules[groupId] = args.join(' ');
    saveDB('rules', rules);
    return reply('✅ Regras definidas!');
  }

  if (command === '#gpinfo' || command === '#grupoinfo') {
    try {
      const meta = await sock.groupMetadata(groupId);
      const admins = meta.participants.filter(p => p.admin).length;
      return reply(`📋 *Informacoes do Grupo*\n\nNome: ${meta.subject}\nDescricao: ${meta.desc || '-'}\nCriado: ${new Date(meta.creation * 1000).toLocaleString('pt-BR')}\nMembros: ${meta.participants.length}\nAdmins: ${admins}`);
    } catch (err) { 
      return reply('❌ Erro: ' + err.message); 
    }
  }

  if (command === '#admins') {
    try {
      const meta = await sock.groupMetadata(groupId);
      const admins = meta.participants.filter(p => p.admin);
      let text = '👑 *Admins do grupo:*\n\n';
      admins.forEach(a => { text += `@${a.id.split('@')[0]}\n`; });
      return sock.sendMessage(groupId, { text, mentions: admins.map(a => a.id) });
    } catch { 
      return reply('❌ Erro ao buscar admins.'); 
    }
  }

  if (command === '#so_adm') {
    if (!cargoCheck(groupId, 'admin')) return reply('❌ Sem permissao.');
    if (args[0] === 'on') { 
      settings.soAdm = true; 
      saveSettings(); 
      return reply('✅ Modo so-admins ativado!'); 
    }
    if (args[0] === 'off') { 
      settings.soAdm = false; 
      saveSettings(); 
      return reply('✅ Modo so-admins desativado.'); 
    }
    return reply(`Modo so-admins: ${settings.soAdm ? 'Ativado' : 'Desativado'}\nUse: #so_adm [on/off]`);
  }

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
    return reply(`Boas-vindas: ${settings.welcome ? 'Ativado' : 'Desativado'}\nUse: #bemvindo [on/off]`);
  }

  if (command === '#antilink') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    if (args[0] === 'on') { 
      settings.antilink = true; 
      saveSettings(); 
      return reply('✅ Antilink ativado! Apenas Instagram, YouTube e TikTok permitidos.'); 
    }
    if (args[0] === 'off') { 
      settings.antilink = false; 
      saveSettings(); 
      return reply('✅ Antilink desativado.'); 
    }
    return reply(`Antilink: ${settings.antilink ? 'Ativado' : 'Desativado'}\nUse: #antilink [on/off]`);
  }

  if (command === '#antipalavra') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    if (args[0] === 'on') { 
      settings.antiPalavra = true; 
      saveSettings(); 
      return reply('✅ Filtro de palavroes ativado!'); 
    }
    if (args[0] === 'off') { 
      settings.antiPalavra = false; 
      saveSettings(); 
      return reply('✅ Filtro de palavroes desativado.'); 
    }
    return reply(`Filtro de palavroes: ${settings.antiPalavra ? 'Ativado' : 'Desativado'}\nUse: #antipalavra [on/off]`);
  }

  if (command === '#addpalavra') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    if (!args.length) return reply('Use: #addpalavra [palavra]');
    const word = args[0].toLowerCase();
    if (!settings.palavroes) settings.palavroes = [];
    if (!settings.palavroes.includes(word)) { 
      settings.palavroes.push(word); 
      saveSettings(); 
      return reply(`✅ Palavra "${word}" adicionada ao filtro.`); 
    }
    return reply('Palavra ja esta no filtro.');
  }

  if (command === '#delpalavra') {
    if (!cargoCheck(groupId, 'admin', 'mod')) return reply('❌ Sem permissao.');
    if (!args.length) return reply('Use: #delpalavra [palavra]');
    const word = args[0].toLowerCase();
    settings.palavroes = (settings.palavroes || []).filter(p => p !== word);
    saveSettings();
    return reply(`✅ Palavra "${word}" removida do filtro.`);
  }

  if (command === '#listapalavrao') {
    if (!settings.palavroes || !settings.palavroes.length) return reply('Nenhum palavrao no filtro.');
    return reply(`Palavroes no filtro:\n\n${settings.palavroes.join(', ')}`);
  }

  // ===========================================================
  // RANKING / ATIVIDADE
  // ===========================================================

  if (command === '#rankativos') {
    const activity = userActivity[groupId];
    if (!activity || !Object.keys(activity).length) return reply('Nenhuma atividade registrada ainda.');
    const sorted = Object.entries(activity).sort((a, b) => b[1].messageCount - a[1].messageCount).slice(0, 10);
    let text = '📊 *Top 10 Membros Mais Ativos:*\n\n';
    sorted.forEach(([uid, data], i) => {
      text += `${i + 1}. @${uid.split('@')[0]} — ${data.messageCount} msgs\n`;
    });
    return sock.sendMessage(groupId, { text, mentions: sorted.map(([uid]) => uid) });
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
    return reply(`🎲 Dado de ${lados} lados: *${result}*`);
  }

  if (command === '#porcentagem' || command === '#chance') {
    const text = args.join(' ') || senderName;
    const pct = Math.floor(Math.random() * 101);
    return reply(`${text}: ${pct}%`);
  }

  if (command === '#8ball') {
    const respostas = ['Sim!', 'Nao.', 'Talvez...', 'Com certeza!', 'Definitivamente nao.', 'Provavelmente sim.'];
    return reply(`🎱 Pergunta: ${args.join(' ')}\n\nResposta: ${respostas[Math.floor(Math.random() * respostas.length)]}`);
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
        text: `💕 O casal do dia e:\n@${p1.id.split('@')[0]} + @${p2.id.split('@')[0]}`,
        mentions: [p1.id, p2.id],
      });
    } catch { 
      return reply('Erro ao sortear casal.'); 
    }
  }

  // RANKS DE BRINCADEIRA
  const rankCommands = ['#rankgay', '#rankgado', '#rankcorno'];
  if (rankCommands.includes(command)) {
    try {
      const meta = await sock.groupMetadata(groupId);
      const members = meta.participants;
      const winner = members[Math.floor(Math.random() * members.length)];
      const rankName = command.replace('#rank', '').charAt(0).toUpperCase() + command.replace('#rank', '').slice(1);
      const pct = Math.floor(Math.random() * 100) + 1;
      return sock.sendMessage(groupId, {
        text: `🏆 *Rank ${rankName} do dia:*\n\n@${winner.id.split('@')[0]} com ${pct}%!`,
        mentions: [winner.id],
      });
    } catch { 
      return reply('Erro ao calcular ranking.'); 
    }
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
    return reply(`🎂 Aniversario cadastrado: ${String(d).padStart(2,'0')}/${String(m).padStart(2,'0')}`);
  }

  if (command === '#meuaniversario') {
    const b = birthdays[groupId]?.[sender];
    if (!b) return reply('Voce nao cadastrou seu aniversario. Use: #aniversario [DD/MM]');
    return reply(`🎂 Seu aniversario: ${String(b.day).padStart(2,'0')}/${String(b.month).padStart(2,'0')}`);
  }

  // ===========================================================
  // FEEDBACK
  // ===========================================================

  if (command === '#feedback') {
    if (!args.length) return reply('Use: #feedback [seu feedback]');
    const fb = args.join(' ');
    await sock.sendMessage(OWNER_JIDS[0], {
      text: `📝 *Feedback recebido!*\nGrupo: ${groupId}\nMembro: @${sender.split('@')[0]} (${senderName})\n\n${fb}`,
    });
    return reply('✅ Feedback enviado ao dono do bot! Obrigado.');
  }

  // ===========================================================
  // COMANDO NAO ENCONTRADO
  // ===========================================================

  if (command.startsWith('#') || command.startsWith('/')) {
    return reply('❌ Comando nao encontrado. Use #menu para ver os comandos disponiveis.');
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
  } catch (e) { 
    console.log('[SignaBot] Erro ao remover sessao: ' + e.message); 
  }
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
      console.log('[SignaBot] Numero do bot: ' + sock.user?.id?.split(':')[0] || 'desconhecido');
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

        // Registrar atividade
        if (isGroup) logActivity(groupId, sender);

        const settings = isGroup ? getGroupSettings(groupId) : {};

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
        }

        // Iniciar teste grátis automaticamente (10 minutos)
        if (isGroup && !subscriptions[groupId] && !blacklist[sender]) {
          subscriptions[groupId] = {
            type: 'trial',
            activatedAt: Date.now(),
            expiresAt: Date.now() + (10 * 60 * 1000), // 10 minutos
            notified: false
          };
          saveDB('subscriptions', subscriptions);
          
          await sock.sendMessage(groupId, {
            text: `🎉 *Teste Grátis Ativado!*\n\n⏰ Duração: 10 minutos\n\nApós o teste, o bot será bloqueado até que o dono ative a assinatura com o comando:\n!ativar [30|60] dias\n\nContato do dono:\nwa.me/${OWNER_NUMBER}`,
          });
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

  // ============================================================
  // EVENTOS DE GRUPO (entrar/sair)
  // ============================================================

  sock.ev.on('group-participants.update', async ({ id: groupId, participants, action }) => {
    const settings = getGroupSettings(groupId);
    
    if (action === 'add' && settings.welcome) {
      for (const participant of participants) {
        // Verificar lista negra
        if (blacklist[participant]) {
          try { 
            await sock.groupParticipantsUpdate(groupId, [participant], 'remove'); 
          } catch {}
          continue;
        }

        const welcomeMsg = `👋 Bem-vindo(a) ao grupo, @${participant.split('@')[0]}!\n\nDigite #menu para ver os comandos disponíveis.`;

        try {
          await sock.sendMessage(groupId, {
            text: welcomeMsg,
            mentions: [participant],
          });
        } catch {
          await sock.sendMessage(groupId, {
            text: welcomeMsg,
            mentions: [participant],
          }).catch(() => {});
        }
      }
    }
  });

  // Verificar assinaturas expiradas a cada minuto
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

  return sock;
};

// Iniciar bot
connectBot().catch(err => {
  console.log('[SignaBot] Erro fatal ao iniciar: ' + err.message);
  setTimeout(() => connectBot(), 10000);
});
