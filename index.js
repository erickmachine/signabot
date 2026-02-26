// ================================
// SIGNABOT - Bot WhatsApp Completo
// ================================

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  downloadContentFromMessage,
  jidDecode,
  generateWAMessageFromContent,
  proto,
  prepareWAMessageMedia,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const yts = require('yt-search');
const ytdl = require('ytdl-core');

// ================================
// SIGNABOT - Bot WhatsApp Completo
// ================================

const PREFIX = '#';
const BOT_NAME = 'SignaBot';
const OWNER_NUMBER = '5592999652961';
// Corrigido: formato correto do JID
const OWNER_JIDS = [
  `55${OWNER_NUMBER.replace(/^55/, '')}@s.whatsapp.net`, 
  '559299652961@s.whatsapp.net'
];

// Comandos que o dono pode executar mesmo com assinatura expirada
const OWNER_COMMANDS = ['!ativar', '!status', '!cancelar'];

// Base de dados em JSON
const DATA_DIR = path.join(__dirname, 'database');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const loadDB = (name) => {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, '{}');
    return {};
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const saveDB = (name, data) => {
  const file = path.join(DATA_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// Databases
let subscriptions = loadDB('subscriptions');
let warnings = loadDB('warnings');
let blacklist = loadDB('blacklist');
let groupSettings = loadDB('groupSettings');
let userActivity = loadDB('userActivity');
let schedules = loadDB('schedules');

// Função para salvar todos os DBs
const saveAllDB = () => {
  saveDB('subscriptions', subscriptions);
  saveDB('warnings', warnings);
  saveDB('blacklist', blacklist);
  saveDB('groupSettings', groupSettings);
  saveDB('userActivity', userActivity);
  saveDB('schedules', schedules);
};

// Verificar se usuário é dono (CORRIGIDO)
const isOwner = (sender) => {
  return OWNER_JIDS.some(jid => sender.includes(jid.replace('@s.whatsapp.net', '')));
};

// Verificar se usuário é admin do grupo
const isAdmin = async (sock, groupId, userId) => {
  try {
    const groupMetadata = await sock.groupMetadata(groupId);
    const participant = groupMetadata.participants.find((p) => p.id === userId);
    return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
  } catch {
    return false;
  }
};

// Verificar assinatura do grupo
const checkSubscription = (groupId) => {
  const sub = subscriptions[groupId];
  if (!sub) return { active: false, reason: 'Sem assinatura' };
  
  const now = Date.now();
  
  // Se já expirou, retorna inativo independente do tipo
  if (now > sub.expiresAt) {
    return { 
      active: false, 
      reason: sub.type === 'trial' ? 'Teste grátis expirado' : 'Assinatura expirada',
      type: sub.type,
      expiresAt: sub.expiresAt 
    };
  }
  
  // Ainda está ativo
  return { 
    active: true, 
    type: sub.type, 
    expiresAt: sub.expiresAt 
  };
};

// Formatar tempo restante
const formatTimeRemaining = (expiresAt) => {
  const now = Date.now();
  const diff = expiresAt - now;
  if (diff <= 0) return 'Expirado';
  
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

// Registrar atividade do usuário
const logActivity = (groupId, userId) => {
  if (!userActivity[groupId]) userActivity[groupId] = {};
  userActivity[groupId][userId] = {
    lastActive: Date.now(),
    messageCount: (userActivity[groupId][userId]?.messageCount || 0) + 1,
  };
  saveDB('userActivity', userActivity);
};

// Obter configurações do grupo
const getGroupSettings = (groupId) => {
  if (!groupSettings[groupId]) {
    groupSettings[groupId] = {
      antilink: false,
      welcome: false,
      antiSpam: false,
      autoBaixar: false,
      simih: false,
      antiPalavra: false,
      palavroes: [],
      bemVindoMsg: 'Bem-vindo(a) ao grupo!',
      saiuMsg: 'Saiu do grupo.',
    };
    saveDB('groupSettings', groupSettings);
  }
  return groupSettings[groupId];
};

// ================================
// FUNÇÕES DE MÍDIA E DOWNLOAD
// ================================

const downloadMediaMessage = async (message) => {
  try {
    const buffer = await downloadContentFromMessage(
      message,
      message.imageMessage ? 'image' : message.videoMessage ? 'video' : 'audio'
    );
    let data = Buffer.from([]);
    for await (const chunk of buffer) {
      data = Buffer.concat([data, chunk]);
    }
    return data;
  } catch {
    return null;
  }
};

const searchYoutube = async (query) => {
  try {
    const result = await yts(query);
    return result.videos.length > 0 ? result.videos[0] : null;
  } catch {
    return null;
  }
};

const downloadYoutube = async (url, type = 'audio') => {
  try {
    const info = await ytdl.getInfo(url);
    const format = type === 'audio' 
      ? ytdl.chooseFormat(info.formats, { quality: 'highestaudio' })
      : ytdl.chooseFormat(info.formats, { quality: 'highest' });
    
    return {
      stream: ytdl(url, { format }),
      title: info.videoDetails.title,
      thumbnail: info.videoDetails.thumbnails[0].url,
    };
  } catch {
    return null;
  }
};

// ================================
// HANDLER DE COMANDOS
// ================================

const handleCommand = async (sock, message, groupId, sender, command, args, isGroup) => {
  const senderName = message.pushName || 'Usuário';
  const reply = (text) => sock.sendMessage(groupId, { text }, { quoted: message });
  
  // Log para debug
  console.log(`[COMANDO] ${command} de ${sender} no grupo ${groupId}`);
  console.log(`[OWNER] É dono? ${isOwner(sender)}`);
  
  // Só verifica assinatura se for grupo e NÃO for comando do dono
  if (isGroup && !isOwner(sender)) {
    const sub = checkSubscription(groupId);
    
    // Se não estiver ativo, bloqueia TODOS os comandos (exceto #menu que é informativo)
    if (!sub.active) {
      // Permite apenas #menu para informar sobre a assinatura
      if (command === '#menu') {
        // Deixa passar para mostrar o menu
      } else {
        return reply(`⚠️ *Acesso Bloqueado*\n\nO período de ${sub.type === 'trial' ? 'teste grátis' : 'assinatura'} expirou.\n\nEntre em contato com o dono para ativar:\nwa.me/${OWNER_NUMBER}`);
      }
    }
  }
  
  const settings = getGroupSettings(groupId);
  const adminCheck = isGroup ? await isAdmin(sock, groupId, sender) : false;
  
  // ================================
  // COMANDOS DO DONO - ASSINATURA
  // ================================
  
  if (command === '!ativar' && isGroup) {
    // Verifica se é o dono
    if (!isOwner(sender)) {
      return reply('❌ Apenas o dono do bot pode usar este comando.');
    }
    
    if (args.length < 1) {
      return reply('Use: !ativar [30|60] dias');
    }
    
    const days = parseInt(args[0]);
    if (![30, 60].includes(days)) {
      return reply('Escolha 30 ou 60 dias.');
    }
    
    const expiresAt = Date.now() + (days * 24 * 60 * 60 * 1000);
    subscriptions[groupId] = {
      type: 'paid',
      activatedAt: Date.now(),
      expiresAt,
      days,
      notified: false
    };
    saveDB('subscriptions', subscriptions);
    
    const dataExpiracao = new Date(expiresAt).toLocaleString('pt-BR');
    return reply(`✅ *Assinatura Ativada!*\n\n📆 Período: ${days} dias\n⏰ Expira em: ${dataExpiracao}\n\nAgora o grupo pode usar todos os comandos!`);
  }
  
  if (command === '!status' && isGroup) {
    const sub = checkSubscription(groupId);
    
    if (!sub.active) {
      const dataExpiracao = sub.expiresAt ? new Date(sub.expiresAt).toLocaleString('pt-BR') : 'N/A';
      return reply(`❌ *Assinatura Inativa*\n\nMotivo: ${sub.reason}\nExpirou em: ${dataExpiracao}\n\nContate o dono para ativar:\nwa.me/${OWNER_NUMBER}`);
    }
    
    const timeLeft = formatTimeRemaining(sub.expiresAt);
    const type = sub.type === 'trial' ? '🔰 Teste Grátis' : '💎 Assinatura Paga';
    const dataExpiracao = new Date(sub.expiresAt).toLocaleString('pt-BR');
    
    return reply(`📊 *Status da Assinatura*\n\n${type}\n⏳ Tempo restante: ${timeLeft}\n📅 Expira em: ${dataExpiracao}`);
  }
  
  if (command === '!cancelar' && isGroup) {
    if (!isOwner(sender)) {
      return reply('❌ Apenas o dono do bot pode usar este comando.');
    }
    
    if (!subscriptions[groupId]) {
      return reply('❌ Este grupo não possui assinatura ativa.');
    }
    
    delete subscriptions[groupId];
    saveDB('subscriptions', subscriptions);
    return reply('🚫 *Assinatura Cancelada*\n\nO grupo não terá mais acesso aos comandos.');
  }
  
  // ================================
  // COMANDOS GERAIS - MENU
  // ================================
  
  if (command === '#menu') {
    const sub = isGroup ? checkSubscription(groupId) : { active: true };
    
    let statusText = '';
    if (isGroup && !isOwner(sender)) {
      if (!sub.active) {
        statusText = `\n⚠️ *Acesso Bloqueado*\nMotivo: ${sub.reason}\n`;
      } else {
        const timeLeft = formatTimeRemaining(sub.expiresAt);
        statusText = `\n📊 Status: ${sub.type === 'trial' ? '🔰 Teste' : '💎 Ativo'} (${timeLeft} restantes)\n`;
      }
    }
    
    const menuText = `
╔═══════════════════╗
║   ${BOT_NAME} - Menu Principal   ║
╚═══════════════════╝
${statusText}
📋 *Menus Disponíveis:*

${!sub.active && !isOwner(sender) ? '🔒 ' : '⎨⎟⟐⃟➪ '}#menu-figurinhas
${!sub.active && !isOwner(sender) ? '🔒 ' : '⎨⎟⟐⃟➪ '}#menu-brincadeiras
${!sub.active && !isOwner(sender) ? '🔒 ' : '⎨⎟⟐⃟➪ '}#menu-adm
${!sub.active && !isOwner(sender) ? '🔒 ' : '⎨⎟⟐⃟➪ '}#menu-download
${!sub.active && !isOwner(sender) ? '🔒 ' : '⎨⎟⟐⃟➪ '}#menu-info
${!sub.active && !isOwner(sender) ? '🔒 ' : '⎨⎟⟐⃟➪ '}#menu-grupo

💎 *Assinatura:*
!status - Ver status da assinatura

🔧 *Desenvolvido por:*
wa.me/${OWNER_NUMBER}
    `.trim();
    
    return reply(menuText);
  }
  
  if (command === '#menu-figurinhas') {
    // Verifica assinatura novamente para comandos específicos
    if (isGroup && !isOwner(sender)) {
      const sub = checkSubscription(groupId);
      if (!sub.active) {
        return reply(`⚠️ *Acesso Bloqueado*\n\nMotivo: ${sub.reason}\n\nContate o dono: wa.me/${OWNER_NUMBER}`);
      }
    }
    
    return reply(`
📦 *Menu Figurinhas*

#sticker - Criar figurinha (marque imagem/vídeo)
#toimg - Converter figurinha em imagem
#take [autor] [pack] - Mudar autor da figurinha
#emoji [emoji] - Criar figurinha de emoji
    `.trim());
  }
  
  if (command === '#menu-download') {
    // Verifica assinatura novamente para comandos específicos
    if (isGroup && !isOwner(sender)) {
      const sub = checkSubscription(groupId);
      if (!sub.active) {
        return reply(`⚠️ *Acesso Bloqueado*\n\nMotivo: ${sub.reason}\n\nContate o dono: wa.me/${OWNER_NUMBER}`);
      }
    }
    
    return reply(`
📥 *Menu Download*

#play [nome/url] - Baixar áudio do YouTube
#playvideo [nome/url] - Baixar vídeo do YouTube
#tiktok [url] - Baixar vídeo do TikTok
#instagram [url] - Baixar do Instagram
#pinterest [busca] - Buscar imagens
    `.trim());
  }
  
  if (command === '#menu-adm') {
    // Verifica assinatura novamente para comandos específicos
    if (isGroup && !isOwner(sender)) {
      const sub = checkSubscription(groupId);
      if (!sub.active) {
        return reply(`⚠️ *Acesso Bloqueado*\n\nMotivo: ${sub.reason}\n\nContate o dono: wa.me/${OWNER_NUMBER}`);
      }
    }
    
    if (!adminCheck && !isOwner(sender)) {
      return reply('❌ Apenas admins podem usar este comando.');
    }
    
    return reply(`
👑 *Menu Administração*

#ban @usuario - Banir membro
#add [número] - Adicionar membro
#promover @usuario - Promover a admin
#rebaixar @usuario - Remover admin
#grupo [abrir|fechar] - Abrir/fechar grupo
#linkgp - Link do grupo
#marcar [texto] - Marcar todos
#advertir @usuario - Advertir membro
#checkwarnings @usuario - Ver advertências
#bemvindo [on|off] - Ativar/desativar boas-vindas
#antilink [on|off] - Ativar/desativar antilink
    `.trim());
  }
  
  if (command === '#menu-grupo') {
    // Verifica assinatura novamente para comandos específicos
    if (isGroup && !isOwner(sender)) {
      const sub = checkSubscription(groupId);
      if (!sub.active) {
        return reply(`⚠️ *Acesso Bloqueado*\n\nMotivo: ${sub.reason}\n\nContate o dono: wa.me/${OWNER_NUMBER}`);
      }
    }
    
    return reply(`
👥 *Menu Grupo*

#rankativos - Ranking de atividade
#inativos [dias] - Ver membros inativos
#gpinfo - Informações do grupo
#regras - Regras do grupo
    `.trim());
  }
  
  if (command === '#menu-info') {
    // Verifica assinatura novamente para comandos específicos
    if (isGroup && !isOwner(sender)) {
      const sub = checkSubscription(groupId);
      if (!sub.active) {
        return reply(`⚠️ *Acesso Bloqueado*\n\nMotivo: ${sub.reason}\n\nContate o dono: wa.me/${OWNER_NUMBER}`);
      }
    }
    
    return reply(`
ℹ️ *Menu Informações*

#info - Informações do bot
#dono - Contato do dono
#ping - Velocidade do bot
#idiomas - Idiomas suportados
    `.trim());
  }
  
  // ================================
  // COMANDOS - FIGURINHAS
  // ================================
  
  if (command === '#sticker' || command === '#fig') {
    // Verifica assinatura novamente para comandos específicos
    if (isGroup && !isOwner(sender)) {
      const sub = checkSubscription(groupId);
      if (!sub.active) {
        return reply(`⚠️ *Acesso Bloqueado*\n\nMotivo: ${sub.reason}\n\nContate o dono: wa.me/${OWNER_NUMBER}`);
      }
    }
    
    const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted || (!quoted.imageMessage && !quoted.videoMessage)) {
      return reply('❌ Marque uma imagem ou vídeo!');
    }
    
    try {
      const media = await downloadMediaMessage(
        quoted.imageMessage || quoted.videoMessage
      );
      
      if (!media) {
        return reply('❌ Erro ao baixar mídia.');
      }
      
      await sock.sendMessage(groupId, {
        sticker: media,
      }, { quoted: message });
    } catch (err) {
      return reply('❌ Erro ao criar figurinha: ' + err.message);
    }
  }
  
  // ================================
  // COMANDOS - DOWNLOAD
  // ================================
  
  if (command === '#play') {
    // Verifica assinatura novamente para comandos específicos
    if (isGroup && !isOwner(sender)) {
      const sub = checkSubscription(groupId);
      if (!sub.active) {
        return reply(`⚠️ *Acesso Bloqueado*\n\nMotivo: ${sub.reason}\n\nContate o dono: wa.me/${OWNER_NUMBER}`);
      }
    }
    
    if (args.length === 0) {
      return reply('❌ Use: #play [nome da música]');
    }
    
    const query = args.join(' ');
    const video = await searchYoutube(query);
    
    if (!video) {
      return reply('❌ Nenhum resultado encontrado.');
    }
    
    await reply(`🎵 *${video.title}*\n\n⏱️ Duração: ${video.timestamp}\n👁️ Views: ${video.views}\n\n⏳ Baixando áudio...`);
    
    try {
      const download = await downloadYoutube(video.url, 'audio');
      if (!download) {
        return reply('❌ Erro ao baixar áudio.');
      }
      
      await sock.sendMessage(groupId, {
        audio: { stream: download.stream },
        mimetype: 'audio/mpeg',
        ptt: false,
      }, { quoted: message });
    } catch (err) {
      return reply('❌ Erro ao processar áudio: ' + err.message);
    }
  }
  
  if (command === '#playvideo') {
    // Verifica assinatura novamente para comandos específicos
    if (isGroup && !isOwner(sender)) {
      const sub = checkSubscription(groupId);
      if (!sub.active) {
        return reply(`⚠️ *Acesso Bloqueado*\n\nMotivo: ${sub.reason}\n\nContate o dono: wa.me/${OWNER_NUMBER}`);
      }
    }
    
    if (args.length === 0) {
      return reply('❌ Use: #playvideo [nome do vídeo]');
    }
    
    const query = args.join(' ');
    const video = await searchYoutube(query);
    
    if (!video) {
      return reply('❌ Nenhum resultado encontrado.');
    }
    
    await reply(`🎬 *${video.title}*\n\n⏱️ Duração: ${video.timestamp}\n\n⏳ Baixando vídeo...`);
    
    try {
      const download = await downloadYoutube(video.url, 'video');
      if (!download) {
        return reply('❌ Erro ao baixar vídeo.');
      }
      
      await sock.sendMessage(groupId, {
        video: { stream: download.stream },
        caption: `🎬 *${download.title}*`,
      }, { quoted: message });
    } catch (err) {
      return reply('❌ Erro ao processar vídeo: ' + err.message);
    }
  }
  
  // ================================
  // COMANDOS - ADMINISTRAÇÃO
  // ================================
  
  if (command === '#ban') {
    if (!adminCheck && !isOwner(sender)) {
      return reply('❌ Apenas admins podem usar este comando.');
    }
    
    const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned || mentioned.length === 0) {
      return reply('❌ Marque um usuário para banir!');
    }
    
    const userId = mentioned[0];
    
    try {
      await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
      return reply(`✅ Usuário banido com sucesso!`);
    } catch (err) {
      return reply('❌ Erro ao banir usuário: ' + err.message);
    }
  }
  
  if (command === '#promover') {
    if (!adminCheck && !isOwner(sender)) {
      return reply('❌ Apenas admins podem usar este comando.');
    }
    
    const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned || mentioned.length === 0) {
      return reply('❌ Marque um usuário para promover!');
    }
    
    const userId = mentioned[0];
    
    try {
      await sock.groupParticipantsUpdate(groupId, [userId], 'promote');
      return reply(`✅ Usuário promovido a admin!`);
    } catch (err) {
      return reply('❌ Erro ao promover usuário: ' + err.message);
    }
  }
  
  if (command === '#rebaixar') {
    if (!adminCheck && !isOwner(sender)) {
      return reply('❌ Apenas admins podem usar este comando.');
    }
    
    const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned || mentioned.length === 0) {
      return reply('❌ Marque um usuário para rebaixar!');
    }
    
    const userId = mentioned[0];
    
    try {
      await sock.groupParticipantsUpdate(groupId, [userId], 'demote');
      return reply(`✅ Usuário rebaixado!`);
    } catch (err) {
      return reply('❌ Erro ao rebaixar usuário: ' + err.message);
    }
  }
  
  if (command === '#grupo') {
    if (!adminCheck && !isOwner(sender)) {
      return reply('❌ Apenas admins podem usar este comando.');
    }
    
    if (args.length === 0) {
      return reply('Use: #grupo [abrir|fechar]');
    }
    
    const action = args[0].toLowerCase();
    
    try {
      if (action === 'fechar') {
        await sock.groupSettingUpdate(groupId, 'announcement');
        return reply('🔒 Grupo fechado! Apenas admins podem enviar mensagens.');
      } else if (action === 'abrir') {
        await sock.groupSettingUpdate(groupId, 'not_announcement');
        return reply('🔓 Grupo aberto! Todos podem enviar mensagens.');
      } else {
        return reply('Use: #grupo [abrir|fechar]');
      }
    } catch (err) {
      return reply('❌ Erro: ' + err.message);
    }
  }
  
  if (command === '#linkgp') {
    try {
      const inviteCode = await sock.groupInviteCode(groupId);
      return reply(`🔗 Link do grupo:\nhttps://chat.whatsapp.com/${inviteCode}`);
    } catch (err) {
      return reply('❌ Erro ao obter link: ' + err.message);
    }
  }
  
  if (command === '#marcar') {
    if (!adminCheck && !isOwner(sender)) {
      return reply('❌ Apenas admins podem usar este comando.');
    }
    
    try {
      const groupMetadata = await sock.groupMetadata(groupId);
      const participants = groupMetadata.participants.map((p) => p.id);
      const text = args.join(' ') || 'Marcação geral!';
      
      await sock.sendMessage(groupId, {
        text: `📢 *Marcação Geral*\n\n${text}`,
        mentions: participants,
      });
    } catch (err) {
      return reply('❌ Erro: ' + err.message);
    }
  }
  
  if (command === '#advertir') {
    if (!adminCheck && !isOwner(sender)) {
      return reply('❌ Apenas admins podem usar este comando.');
    }
    
    const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned || mentioned.length === 0) {
      return reply('❌ Marque um usuário para advertir!');
    }
    
    const userId = mentioned[0];
    
    if (!warnings[groupId]) warnings[groupId] = {};
    if (!warnings[groupId][userId]) warnings[groupId][userId] = [];
    
    warnings[groupId][userId].push({
      date: Date.now(),
      reason: args.join(' ') || 'Sem motivo especificado',
    });
    
    saveDB('warnings', warnings);
    
    const count = warnings[groupId][userId].length;
    
    if (count >= 3) {
      try {
        await sock.groupParticipantsUpdate(groupId, [userId], 'remove');
        delete warnings[groupId][userId];
        saveDB('warnings', warnings);
        return reply(`🚫 Usuário banido por atingir 3 advertências!`);
      } catch (err) {
        return reply('❌ Erro ao banir: ' + err.message);
      }
    }
    
    return reply(`⚠️ Usuário advertido!\nAdvertências: ${count}/3`);
  }
  
  if (command === '#checkwarnings') {
    const mentioned = message.message?.extendedTextMessage?.contextInfo?.mentionedJid;
    const userId = mentioned && mentioned.length > 0 ? mentioned[0] : sender;
    
    if (!warnings[groupId] || !warnings[groupId][userId]) {
      return reply('✅ Este usuário não possui advertências.');
    }
    
    const userWarnings = warnings[groupId][userId];
    let text = `⚠️ *Advertências:* ${userWarnings.length}/3\n\n`;
    
    userWarnings.forEach((w, i) => {
      text += `${i + 1}. ${new Date(w.date).toLocaleString('pt-BR')}\nMotivo: ${w.reason}\n\n`;
    });
    
    return reply(text);
  }
  
  if (command === '#bemvindo') {
    if (!adminCheck && !isOwner(sender)) {
      return reply('❌ Apenas admins podem usar este comando.');
    }
    
    if (args.length === 0) {
      return reply('Use: #bemvindo [on|off]');
    }
    
    const action = args[0].toLowerCase();
    settings.welcome = action === 'on';
    saveDB('groupSettings', groupSettings);
    
    return reply(settings.welcome ? '✅ Boas-vindas ativadas!' : '❌ Boas-vindas desativadas!');
  }
  
  if (command === '#antilink') {
    if (!adminCheck && !isOwner(sender)) {
      return reply('❌ Apenas admins podem usar este comando.');
    }
    
    if (args.length === 0) {
      return reply('Use: #antilink [on|off]');
    }
    
    const action = args[0].toLowerCase();
    settings.antilink = action === 'on';
    saveDB('groupSettings', groupSettings);
    
    return reply(settings.antilink ? '✅ Antilink ativado!' : '❌ Antilink desativado!');
  }
  
  // ================================
  // COMANDOS - GRUPO
  // ================================
  
  if (command === '#rankativos') {
    if (!userActivity[groupId]) {
      return reply('❌ Nenhuma atividade registrada ainda.');
    }
    
    const sorted = Object.entries(userActivity[groupId])
      .sort((a, b) => b[1].messageCount - a[1].messageCount)
      .slice(0, 10);
    
    let text = '📊 *Top 10 Membros Ativos*\n\n';
    
    for (let i = 0; i < sorted.length; i++) {
      const [userId, data] = sorted[i];
      const number = userId.split('@')[0];
      text += `${i + 1}. @${number}\nMensagens: ${data.messageCount}\n\n`;
    }
    
    return sock.sendMessage(groupId, {
      text,
      mentions: sorted.map(([userId]) => userId),
    });
  }
  
  if (command === '#gpinfo') {
    try {
      const groupMetadata = await sock.groupMetadata(groupId);
      
      const text = `
📋 *Informações do Grupo*

Nome: ${groupMetadata.subject}
Descrição: ${groupMetadata.desc || 'Sem descrição'}
Criado em: ${new Date(groupMetadata.creation * 1000).toLocaleString('pt-BR')}
Participantes: ${groupMetadata.participants.length}
Admins: ${groupMetadata.participants.filter((p) => p.admin).length}
      `.trim();
      
      return reply(text);
    } catch (err) {
      return reply('❌ Erro ao obter informações: ' + err.message);
    }
  }
  
  // ================================
  // COMANDOS - INFORMAÇÕES
  // ================================
  
  if (command === '#info') {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const text = `
ℹ️ *${BOT_NAME} - Informações*

📌 Versão: 1.0.0
⏰ Tempo online: ${hours}h ${minutes}m
📱 Plataforma: WhatsApp
💻 Node.js: ${process.version}
👤 Dono: wa.me/${OWNER_NUMBER}

🔧 Bot desenvolvido para WhatsApp
    `.trim();
    
    return reply(text);
  }
  
  if (command === '#dono') {
    return reply(`👤 Dono do bot:\nwa.me/${OWNER_NUMBER}`);
  }
  
  if (command === '#ping') {
    const start = Date.now();
    await reply('🏓 Pong!');
    const latency = Date.now() - start;
    return reply(`⚡ Velocidade: ${latency}ms`);
  }
  
  // Comando não encontrado
  if (command.startsWith('#') || command.startsWith('!')) {
    return reply('❌ Comando não encontrado. Use #menu para ver os comandos disponíveis.');
  }
};

// ================================
// CONEXÃO DO BOT
// ================================

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

// Apaga a pasta de sessão para forçar novo QR Code
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

// Contador de erros 405 consecutivos
let fatal405Count = 0;
let reconnectAttempts = 0;

const connectBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version, isLatest } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: Browsers.macOS('Desktop'),
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

    // Exibir QR Code no terminal
    if (qr) {
      fatal405Count = 0;
      console.log('\n==============================');
      console.log('  Escaneie o QR Code abaixo   ');
      console.log('==============================\n');
      qrcode.generate(qr, { small: true });
      console.log('\n==============================\n');
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error;
      const statusCode = (err instanceof Boom) ? err.output.statusCode : 0;

      console.log('[SignaBot] Conexao fechada. Codigo: ' + statusCode);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 440) {
        console.log('[SignaBot] Sessao encerrada (codigo ' + statusCode + '). Limpando e gerando novo QR em 10s...');
        clearSession();
        reconnectAttempts = 0;
        fatal405Count = 0;
        setTimeout(() => connectBot(), 10000);
        return;
      }

      if (statusCode === 405 || statusCode === 403) {
        fatal405Count++;

        if (fatal405Count >= 3) {
          console.log('[SignaBot] Muitas tentativas recusadas (405). IP bloqueado temporariamente.');
          console.log('[SignaBot] Aguardando 10 minutos antes de tentar novamente...');
          fatal405Count = 0;
          setTimeout(() => connectBot(), 10 * 60 * 1000);
        } else {
          const delay = fatal405Count * 60000;
          console.log('[SignaBot] Erro 405 (#' + fatal405Count + '). Aguardando ' + (delay / 1000) + 's...');
          setTimeout(() => connectBot(), delay);
        }
        return;
      }

      const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
      reconnectAttempts++;
      console.log('[SignaBot] Tentativa ' + reconnectAttempts + ' — reconectando em ' + (delay / 1000) + 's...');
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
  
  // Evento de mensagens
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    
    if (!m.message) return;
    if (m.key.fromMe) return;
    
    const messageType = Object.keys(m.message)[0];
    const body =
      messageType === 'conversation'
        ? m.message.conversation
        : messageType === 'extendedTextMessage'
        ? m.message.extendedTextMessage.text
        : '';
    
    const isGroup = m.key.remoteJid.endsWith('@g.us');
    const groupId = m.key.remoteJid;
    const sender = m.key.participant || m.key.remoteJid;
    
    // Registrar atividade
    if (isGroup) {
      logActivity(groupId, sender);
    }
    
    // Iniciar teste grátis automaticamente (10 minutos)
    if (isGroup && !subscriptions[groupId]) {
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
    
    // Antilink
    if (isGroup) {
      const settings = getGroupSettings(groupId);
      if (settings.antilink && !isOwner(sender)) {
        const hasLink = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/.test(body);
        
        if (hasLink) {
          const adminCheck = await isAdmin(sock, groupId, sender);
          if (!adminCheck) {
            await sock.sendMessage(groupId, {
              text: '🚫 Links não são permitidos neste grupo!',
            });
            
            try {
              await sock.sendMessage(groupId, { delete: m.key });
              await sock.groupParticipantsUpdate(groupId, [sender], 'remove');
            } catch {}
          }
        }
      }
    }
    
    // Processar comandos
    if (body.startsWith(PREFIX) || body.startsWith('!')) {
      const args = body.trim().split(/ +/);
      const command = args.shift().toLowerCase();
      
      await handleCommand(sock, m, groupId, sender, command, args, isGroup);
    }
  });
  
  // Evento de participantes (boas-vindas)
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    const settings = getGroupSettings(id);
    
    if (action === 'add' && settings.welcome) {
      for (const participant of participants) {
        const number = participant.split('@')[0];
        
        await sock.sendMessage(id, {
          text: `👋 Bem-vindo(a) @${number}!\n\n${settings.bemVindoMsg}`,
          mentions: [participant],
        });
      }
    }
    
    if (action === 'remove' && settings.welcome) {
      for (const participant of participants) {
        const number = participant.split('@')[0];
        
        await sock.sendMessage(id, {
          text: `👋 @${number} saiu do grupo.\n\n${settings.saiuMsg}`,
          mentions: [participant],
        });
      }
    }
  });
  
  // Verificar assinaturas expiradas a cada minuto
  setInterval(async () => {
    const now = Date.now();
    
    for (const [groupId, sub] of Object.entries(subscriptions)) {
      // Se expirou e ainda não notificou
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
  }, 60000); // Verifica a cada minuto
  
  return sock;
};

// Iniciar bot
connectBot().catch((err) => {
  console.error('❌ Erro ao conectar:', err);
  process.exit(1);
});
