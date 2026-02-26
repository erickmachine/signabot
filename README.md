# SignaBot 🤖

Bot WhatsApp completo, moderno e funcional desenvolvido com Baileys.

---

## Sobre o Bot

**SignaBot** é um bot de WhatsApp poderoso com:
- Sistema de assinatura (teste grátis + planos pagos)
- Mais de 100 comandos organizados por menus
- Moderação automática (antilink, advertências, ban por 3 advertências)
- Downloads automáticos (YouTube, TikTok, Instagram)
- Boas-vindas personalizadas
- Ranking de membros ativos
- Controle total via comandos

---

## Requisitos

- **VPS** com Linux (Ubuntu 20.04 ou superior recomendado)
- **Node.js** v18 ou superior
- **Git** instalado
- **FFmpeg** instalado (para conversão de mídias)

---

## Instalação na VPS

### 1. Conectar na VPS via SSH

```bash
ssh root@129.121.38.161 -p 22022
```

### 2. Instalar dependências do sistema

```bash
apt update && apt upgrade -y
apt install -y git curl ffmpeg
```

### 3. Instalar Node.js 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs
node -v
npm -v
```

### 4. Clonar o repositório

```bash
git clone https://github.com/erickmachine/signabot.git
cd signabot
```

### 5. Renomear os arquivos de configuração

```bash
mv signabot-package.json package.json
mv signabot-.gitignore .gitignore
```

### 6. Instalar dependências

```bash
npm install
```

### 7. Iniciar o bot

```bash
node index.js
```

Um **QR Code** será exibido no terminal. Escaneie com o WhatsApp do número do bot.

---

## Manter o bot rodando (PM2)

Para o bot continuar rodando após fechar o terminal:

```bash
npm install -g pm2
pm2 start index.js --name signabot
pm2 save
pm2 startup
```

Comandos úteis do PM2:

```bash
pm2 logs signabot    # Ver logs
pm2 restart signabot # Reiniciar
pm2 stop signabot    # Parar
pm2 status           # Ver status
```

---

## Sistema de Assinatura

### Teste Grátis
Ao detectar o bot em um grupo pela primeira vez, o teste grátis de **10 minutos** é ativado automaticamente.

### Comandos do Dono (apenas `+5592999652961`)

| Comando | Descrição |
|---------|-----------|
| `!ativar 30 dias` | Ativar assinatura por 30 dias |
| `!ativar 60 dias` | Ativar assinatura por 60 dias |
| `!status` | Ver tempo restante da assinatura |
| `!cancelar` | Cancelar assinatura do grupo |

---

## Comandos Disponíveis

### Menu Principal
```
#menu              - Ver todos os menus
#menu-figurinhas   - Comandos de figurinhas
#menu-download     - Comandos de download
#menu-adm          - Comandos de administração
#menu-grupo        - Comandos do grupo
#menu-info         - Informações do bot
```

### Figurinhas
```
#sticker / #fig    - Criar figurinha (marque imagem/vídeo)
#toimg             - Figurinha para imagem
#take              - Alterar autor da figurinha
#emoji             - Figurinha de emoji
```

### Downloads
```
#play [nome]       - Baixar áudio do YouTube
#playvideo [nome]  - Baixar vídeo do YouTube
#tiktok [url]      - Baixar TikTok
#instagram [url]   - Baixar Instagram
#pinterest [busca] - Buscar imagens
```

### Administração
```
#ban @usuario           - Banir membro
#promover @usuario      - Promover a admin
#rebaixar @usuario      - Remover admin
#advertir @usuario      - Dar advertência (3 = ban)
#checkwarnings @usuario - Ver advertências
#grupo abrir            - Abrir grupo
#grupo fechar           - Fechar grupo
#marcar [texto]         - Marcar todos
#linkgp                 - Link do grupo
#bemvindo on/off        - Ativar boas-vindas
#antilink on/off        - Ativar antilink
```

### Grupo / Info
```
#rankativos    - Top 10 membros mais ativos
#gpinfo        - Informações do grupo
#info          - Informações do bot
#dono          - Contato do dono
#ping          - Testar velocidade
```

---

## Estrutura de Arquivos

```
signabot/
├── index.js            # Código principal do bot (tudo em um arquivo)
├── package.json
├── .gitignore
├── README.md
└── database/           # Criado automaticamente
    ├── subscriptions.json
    ├── warnings.json
    ├── blacklist.json
    ├── groupSettings.json
    ├── userActivity.json
    └── schedules.json
```

---

## Recursos Automáticos

- **Teste grátis de 10 minutos** ao adicionar o bot em um grupo
- **Boas-vindas automáticas** ao ativar com `#bemvindo on`
- **Antilink automático** ao ativar com `#antilink on`
- **3 advertências = ban automático**
- **Notificação de assinatura expirada**
- **Registro de atividade** de todos os membros
- **Reconexão automática** em caso de queda

---

## Prefixo

O bot usa `#` como prefixo padrão para comandos.  
Comandos do dono usam `!`.

---

## Suporte

Dono do bot:  
📱 WhatsApp: [wa.me/5592999652961](https://wa.me/5592999652961)  
🐙 GitHub: [github.com/erickmachine](https://github.com/erickmachine)

---

> **SignaBot** — Que bot lindo! ✨
