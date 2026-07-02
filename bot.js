// Charge le token depuis les variables d'environnement (Railway) ou .env (local)
if (!process.env.DISCORD_TOKEN) {
  try { require('dotenv').config(); } catch {}
}

// Panel web (optionnel - seulement en local)
let startPanel = () => {};
try { ({ startPanel } = require('./panel/server')); } catch {}
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const playdl = require('play-dl');
// Force ffmpeg-static comme encoder audio
process.env.FFMPEG_PATH = require('ffmpeg-static');
const cron = require('node-cron');

// ── Lecteur audio (un par serveur) ───────────────────────────────────────
const audioPlayers = new Map(); // guildId → { player, connection, queue, current }

const SHOP_CHANNEL_ID    = '1522054947661676725';
const TRACKER_CHANNEL_ID = '1522062347651387553';
const GMR_CHANNEL_ID     = '1522142723291742310'; // Guess My Rank

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ── Constantes ────────────────────────────────────────────────────────────
const WELCOME_CHANNEL_ID = '1522025378175258756';
const RANK_CHANNEL_ID    = '1522031444577222727';
const WELCOME_IMAGE      = 'https://www.operationsports.com/wp-content/uploads/2025/03/RL.jpg?fit=1200%2C675';
const AUTO_ROLE_ID       = '1522020794316755096'; // WALLTER korp
const LIVE_ALLOWED_USER  = '470642609224810496';
const TIKTOK_URL         = 'https://www.tiktok.com/@wallter_rl/live';

const LINK_ALLOWED_ROLES = [
  '1522018910948425889', // Owner
  '1522022335714955406', // Staff
  '1522019388264546314', // Fondateur
];

// ── Rangs Rocket League ───────────────────────────────────────────────────
const RANKS = [
  { id: 'rank_bronze',   name: 'Bronze',           emoji: { name: 'Bronze3',          id: '643180459517542413' }, color: 0xcd7f32 },
  { id: 'rank_argent',   name: 'Argent',            emoji: { name: 'Argent3',          id: '643180434007785493' }, color: 0xc0c0c0 },
  { id: 'rank_or',       name: 'Or',                emoji: { name: 'Or3',              id: '643180390986547200' }, color: 0xffd700 },
  { id: 'rank_platine',  name: 'Platine',           emoji: { name: 'Platine3',         id: '1472040058709344504' }, color: 0x00bfff },
  { id: 'rank_diamant',  name: 'Diamant',           emoji: { name: 'Diamant3',         id: '1472041508072067216' }, color: 0x00cfff },
  { id: 'rank_champion', name: 'Champion',          emoji: { name: 'Champion3',        id: '1472043031715643517' }, color: 0x9b59b6 },
  { id: 'rank_gc',       name: 'Grand Champion',    emoji: { name: 'grandchampion1',   id: '1465401214199140434' }, color: 0xe74c3c },
  { id: 'rank_ssl',      name: 'Supersonic Legend', emoji: { name: 'SupersonicLegend', id: '758821358993408020' }, color: 0xf1c40f },
];

// ── Plateformes ───────────────────────────────────────────────────────────
const PLATFORMS = [
  { id: 'plat_pc',          name: 'PC',          emoji: { name: 'pc',          id: '1220902480037023824' }, color: 0x7289da },
  { id: 'plat_playstation', name: 'PlayStation', emoji: { name: 'Playstation', id: '1511422986157297856' }, color: 0x003791 },
  { id: 'plat_xbox',        name: 'Xbox',        emoji: { name: 'Xbox',        id: '1371251509358100480' }, color: 0x107c10 },
  { id: 'plat_switch',      name: 'Switch',      emoji: { name: 'Switch',      id: '643395807869009930'  }, color: 0xe4000f },
];

const rankRoleIds     = {};
const platformRoleIds = {};
const pendingRank     = new Map();

// ── Anti-spam / Anti-lien ─────────────────────────────────────────────────
const LINK_REGEX           = /https?:\/\/|discord\.gg\/|www\./i;
const spamMap              = new Map();
const TIMEOUT_SPAM_LIGHT   = 60 * 1000;
const TIMEOUT_SPAM_HEAVY   = 60 * 60 * 1000;
const TIMEOUT_LINK         = 5 * 60 * 1000;
const SPAM_WINDOW          = 1000;
const SPAM_THRESHOLD_LIGHT = 3;
const SPAM_THRESHOLD_HEAVY = 7;

// ── Helpers ───────────────────────────────────────────────────────────────
async function purgeRecentMessages(channel, userId) {
  try {
    const fetched = await channel.messages.fetch({ limit: 100 });
    const now = Date.now();
    const toDelete = fetched.filter(
      (m) => m.author.id === userId && now - m.createdTimestamp < 60 * 1000
    );
    if (toDelete.size === 0) return;
    if (toDelete.size === 1) await toDelete.first().delete().catch(() => {});
    else await channel.bulkDelete(toDelete, true).catch(() => {});
  } catch (err) {
    console.error('❌ Erreur purge messages :', err.message);
  }
}

async function timeoutMember(member, durationMs) {
  try {
    if (!member.guild.members.me.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    await member.timeout(durationMs);
  } catch (err) {
    console.error(`❌ Impossible de timeout ${member.user.tag} :`, err.message);
  }
}

async function ensureRole(guild, name, color) {
  let role = guild.roles.cache.find((r) => r.name === name);
  if (!role) {
    const templateRole = guild.roles.cache.get(AUTO_ROLE_ID);
    role = await guild.roles.create({
      name,
      color,
      permissions: templateRole ? templateRole.permissions : [],
      reason: 'Création automatique rôle RL',
    });
    console.log(`✅ Rôle créé : ${name}`);
  }
  return role;
}

function buildRankButtons() {
  const rows = [];
  for (let i = 0; i < RANKS.length; i += 4) {
    const row = new ActionRowBuilder();
    RANKS.slice(i, i + 4).forEach((rank) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(rank.id)
          .setLabel(rank.name)
          .setEmoji({ name: rank.emoji.name, id: rank.emoji.id })
          .setStyle(ButtonStyle.Secondary)
      );
    });
    rows.push(row);
  }
  return rows;
}

function buildPlatformButtons() {
  const row = new ActionRowBuilder();
  PLATFORMS.forEach((plat) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(plat.id)
        .setLabel(plat.name)
        .setEmoji({ name: plat.emoji.name, id: plat.emoji.id })
        .setStyle(ButtonStyle.Secondary)
    );
  });
  return [row];
}

async function setupRankMessage(guild) {
  const channel = guild.channels.cache.get(RANK_CHANNEL_ID);
  if (!channel) { console.error('❌ Salon de rang introuvable.'); return; }

  for (const rank of RANKS) {
    const role = await ensureRole(guild, rank.name, rank.color);
    rankRoleIds[rank.id] = role.id;
  }
  for (const plat of PLATFORMS) {
    const role = await ensureRole(guild, plat.name, plat.color);
    platformRoleIds[plat.id] = role.id;
  }

  const messages = await channel.messages.fetch({ limit: 20 });
  const existing = messages.find((m) => m.author.id === client.user.id && m.components.length > 0);
  if (existing) { console.log('ℹ️ Message de rang déjà présent, pas de repost.'); return; }

  const embed = new EmbedBuilder()
    .setTitle('🏆 Choisis ton rang Rocket League')
    .setDescription('**Étape 1 :** Clique sur ton rang.\n**Étape 2 :** Choisis ta plateforme.\n\nTu peux changer à tout moment.')
    .setColor(0x5865f2)
    .setImage(WELCOME_IMAGE);

  await channel.send({ embeds: [embed], components: buildRankButtons() });
  console.log('✅ Message de rang envoyé.');
}

async function setupChannelPermissions(guild) {
  const wallterRole = guild.roles.cache.get(AUTO_ROLE_ID);
  if (!wallterRole) { console.error('❌ Rôle WALLTER korp introuvable pour les permissions.'); return; }

  for (const channel of guild.channels.cache.values()) {
    if (channel.type === 4) continue;
    const isVisible = channel.id === RANK_CHANNEL_ID || channel.id === WELCOME_CHANNEL_ID;
    try {
      await channel.permissionOverwrites.edit(wallterRole, {
        ViewChannel:  isVisible,
        SendMessages: false,
      });
    } catch (err) {
      console.error(`❌ Erreur permissions sur #${channel.name} :`, err.message);
    }
  }
  console.log('✅ Permissions des salons configurées.');
}

// ── Guess My Rank ──────────────────────────────────────────────────────────
const fs = require('fs');
const GMR_DATA_FILE = './gmr_data.json';

function loadGmrData() {
  try { return JSON.parse(fs.readFileSync(GMR_DATA_FILE, 'utf8')); }
  catch { return { videos: [], scores: {} }; }
}
function saveGmrData(data) {
  fs.writeFileSync(GMR_DATA_FILE, JSON.stringify(data, null, 2));
}

// Sessions actives : Map<userId, { videos: [], index: 0, score: 0, messageId }>
const gmrSessions = new Map();
// Publish en attente : Map<userId, { channelId, step, mediaUrl? }>
const gmrPendingPublish = new Map();

const GMR_RANKS = [
  { id: 'gmr_Bronze1',   label: 'Bronze I',           emoji: '<:Bronze1:643180472804966400>',        shortcuts: ['b1','bronze1','bronze i'] },
  { id: 'gmr_Bronze2',   label: 'Bronze II',          emoji: '<:Bronze2:643180466240749568>',        shortcuts: ['b2','bronze2','bronze ii'] },
  { id: 'gmr_Bronze3',   label: 'Bronze III',         emoji: '<:Bronze3:1472035459583574077>',       shortcuts: ['b3','bronze3','bronze iii'] },
  { id: 'gmr_Argent1',   label: 'Argent I',           emoji: '<:Argent1:643180450461909032>',        shortcuts: ['a1','argent1','argent i','silver1','silver i','s1'] },
  { id: 'gmr_Argent2',   label: 'Argent II',          emoji: '<:Argent2:643180441926631445>',        shortcuts: ['a2','argent2','argent ii','silver2','silver ii','s2'] },
  { id: 'gmr_Argent3',   label: 'Argent III',         emoji: '<:Argent3:643180434007785493>',        shortcuts: ['a3','argent3','argent iii','silver3','silver iii','s3'] },
  { id: 'gmr_Or1',       label: 'Or I',               emoji: '<:Or1:643180410246791213>',            shortcuts: ['or1','or i','gold1','gold i','o1'] },
  { id: 'gmr_Or2',       label: 'Or II',              emoji: '<:Or2:643180399370960946>',            shortcuts: ['or2','or ii','gold2','gold ii','o2'] },
  { id: 'gmr_Or3',       label: 'Or III',             emoji: '<:Or3:643180390986547200>',            shortcuts: ['or3','or iii','gold3','gold iii','o3'] },
  { id: 'gmr_Platine1',  label: 'Platine I',          emoji: '<:Platine1:643180373337178112>',       shortcuts: ['p1','platine1','platine i','plat1','plat i','platinum1','platinum i'] },
  { id: 'gmr_Platine2',  label: 'Platine II',         emoji: '<:Platine2:643180361613967379>',       shortcuts: ['p2','platine2','platine ii','plat2','plat ii','platinum2','platinum ii'] },
  { id: 'gmr_Platine3',  label: 'Platine III',        emoji: '<:Platine3:643180352910917662>',       shortcuts: ['p3','platine3','platine iii','plat3','plat iii','platinum3','platinum iii'] },
  { id: 'gmr_Diamant1',  label: 'Diamant I',          emoji: '<:Diamant1:643180330412539915>',       shortcuts: ['d1','diamant1','diamant i','diamond1','diamond i'] },
  { id: 'gmr_Diamant2',  label: 'Diamant II',         emoji: '<:Diamant2:1472041347786735697>',      shortcuts: ['d2','diamant2','diamant ii','diamond2','diamond ii'] },
  { id: 'gmr_Diamant3',  label: 'Diamant III',        emoji: '<:Diamant3:1472041508072067216>',      shortcuts: ['d3','diamant3','diamant iii','diamond3','diamond iii'] },
  { id: 'gmr_Champion1', label: 'Champion I',         emoji: '<:Champion1:643180293448007680>',      shortcuts: ['c1','champion1','champion i','champ1','champ i'] },
  { id: 'gmr_Champion2', label: 'Champion II',        emoji: '<:Champion2:643180282857521163>',      shortcuts: ['c2','champion2','champion ii','champ2','champ ii'] },
  { id: 'gmr_Champion3', label: 'Champion III',       emoji: '<:Champion3:643180274175180820>',      shortcuts: ['c3','champion3','champion iii','champ3','champ iii'] },
  { id: 'gmr_GC1',       label: 'Grand Champion I',   emoji: '<:grandchampion1:1465401214199140434>',shortcuts: ['gc1','grand champion i','grandchampion1','gc 1'] },
  { id: 'gmr_GC2',       label: 'Grand Champion II',  emoji: '<:GrandChampion2:758821306170343464>', shortcuts: ['gc2','grand champion ii','grandchampion2','gc 2'] },
  { id: 'gmr_GC3',       label: 'Grand Champion III', emoji: '<:GrandChampion3:758821325321011260>', shortcuts: ['gc3','grand champion iii','grandchampion3','gc 3'] },
  { id: 'gmr_SSL',       label: 'Supersonic Legend',  emoji: '<:SupersonicLegend:758821358993408020>',shortcuts: ['ssl','supersonic','supersonic legend'] },
];

function findGmrRank(input) {
  const s = input.trim().toLowerCase();
  return GMR_RANKS.find(r =>
    r.label.toLowerCase() === s ||
    r.shortcuts.includes(s)
  );
}

function buildGmrRankButtons() {
  const rows = [];
  for (let i = 0; i < GMR_RANKS.length; i += 4) {
    const row = new ActionRowBuilder();
    GMR_RANKS.slice(i, i + 4).forEach(r => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(r.id)
          .setLabel(r.label)
          .setEmoji(r.emoji.match(/<:(\w+):(\d+)>/)
            ? { name: r.emoji.match(/<:(\w+):(\d+)>/)[1], id: r.emoji.match(/<:(\w+):(\d+)>/)[2] }
            : { name: r.emoji })
          .setStyle(ButtonStyle.Secondary)
      );
    });
    rows.push(row);
  }
  return rows;
}

function buildGmrMainButtons() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gmr_play').setLabel('▶ Play').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('gmr_publish').setLabel('📤 Publier une vidéo').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('gmr_leaderboard').setLabel('🏆 Leaderboard').setStyle(ButtonStyle.Secondary),
  )];
}

async function setupGmrMessage(guild) {
  const channel = guild.channels.cache.get(GMR_CHANNEL_ID);
  if (!channel) return;
  const messages = await channel.messages.fetch({ limit: 20 });
  const existing = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Guess My Rank'));
  if (existing) { console.log('ℹ️ Message GMR déjà présent.'); return; }

  const embed = new EmbedBuilder()
    .setTitle('🎮 Guess My Rank')
    .setDescription('Regarde des clips Rocket League et essaie de deviner le rang du joueur !\n\n**▶ Play** — Lancer une partie (5 vidéos)\n**📤 Publier** — Ajouter ta propre vidéo\n**🏆 Leaderboard** — Voir le top 10')
    .setColor(0x5865f2)
    .setImage(WELCOME_IMAGE);

  await channel.send({ embeds: [embed], components: buildGmrMainButtons() });
  console.log('✅ Message GMR envoyé.');
}
const puppeteer = require('puppeteer');

async function fetchShopItems() {
  const browser = await puppeteer.launch({
    headless: 'shell',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(30000);

    // Récupère les onglets depuis la page principale
    await page.goto('https://rlshop.gg/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    const tabs = await page.evaluate(() => {
      return [...document.querySelectorAll('a[href]')]
        .map(a => ({ text: a.innerText?.trim().toUpperCase(), href: a.getAttribute('href') }))
        .filter(a => a.text && a.href && /^\/\d*$/.test(a.href) && a.text.length > 2)
        .filter((a, i, arr) => arr.findIndex(b => b.href === a.href) === i);
    });

    const result = [];

    for (const tab of tabs) {
      try {
        const url = 'https://rlshop.gg' + tab.href;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));

        const items = await page.evaluate(() => {
          const results = [];
          document.querySelectorAll('div.group').forEach(card => {
            const label = card.querySelector('[aria-label]');
            const name  = label ? label.getAttribute('aria-label') : '';
            if (!name) return;
            const imgStyle = label.getAttribute('style') || '';
            const imgMatch = imgStyle.match(/url\('([^']+)'\)/);
            const imgUrl   = imgMatch ? 'https://rlshop.gg' + imgMatch[1] : '';
            const text     = card.innerText || '';
            const priceMatch = text.match(/\b(\d{2,5})\b/);
            const paintMatch = text.match(/(Crimson|Cobalt|Forest Green|Sky Blue|Saffron|Purple|Black|Titanium White)/i);
            results.push({
              name,
              img:   imgUrl,
              price: priceMatch?.[1] || '?',
              paint: paintMatch?.[1] || '',
            });
          });
          return results;
        });

        if (items.length > 0) result.push({ tab: tab.text, items });
      } catch (e) {
        console.error(`⚠️ Onglet ${tab.text} ignoré :`, e.message);
      }
    }

    return result;
  } finally {
    await browser.close();
  }
}

// Cache du shop
let shopCache = { tabs: [], fetchedAt: 0 };

async function getShopTabs() {
  const AGE = Date.now() - shopCache.fetchedAt;
  if (shopCache.tabs.length > 0 && AGE < 30 * 60 * 1000) return shopCache.tabs;
  console.log('🔄 Récupération du shop...');
  shopCache.tabs     = await fetchShopItems();
  shopCache.fetchedAt = Date.now();
  console.log(`✅ Shop chargé — ${shopCache.tabs.length} onglets`);
  return shopCache.tabs;
}

const CAT_COLORS = {
  'Animated Decal': 0xff4da6,
  'Decal':          0xff9900,
  'Wheels':         0x00cfff,
  'Rocket Boost':   0xf1c40f,
  'Goal Explosion': 0xe74c3c,
  'Trail':          0x9b59b6,
  'Topper':         0x2ecc71,
  'Antenna':        0x1abc9c,
  'Body':           0x3498db,
  'Autre':          0x5865f2,
};

function buildShopCategoryButtons(categories) {
  const rows = [];
  const cats = [...categories];
  for (let i = 0; i < cats.length; i += 5) {
    const row = new ActionRowBuilder();
    cats.slice(i, i + 5).forEach(cat => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_cat_${cat}`)
          .setLabel(cat)
          .setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }
  return rows;
}

async function sendShop(guild) {
  const channel = guild.channels.cache.get(SHOP_CHANNEL_ID);
  if (!channel) { console.error('❌ Salon shop introuvable.'); return; }

  let tabs = [];
  try { tabs = await getShopTabs(); }
  catch (err) { console.error('❌ Erreur shop :', err.message); return; }

  if (tabs.length === 0) { console.log('⚠️ Shop vide.'); return; }

  // Supprime l'ancien message
  try {
    const old = await channel.messages.fetch({ limit: 10 });
    const botMsg = old.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Shop Rocket League'));
    if (botMsg) await botMsg.delete().catch(() => {});
  } catch {}

  const now     = new Date();
  const dateStr = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const totalItems = tabs.reduce((acc, t) => acc + t.items.length, 0);

  const embed = new EmbedBuilder()
    .setTitle('🛒 Shop Rocket League du jour')
    .setDescription(`**${dateStr}** — ${totalItems} items disponibles\n\nClique sur une catégorie pour voir les items avec leurs images.`)
    .setColor(0x5865f2)
    .setImage('https://www.operationsports.com/wp-content/uploads/2025/03/RL.jpg?fit=1200%2C675')
    .setTimestamp()
    .setFooter({ text: 'Renouvellement à 19h00 UTC • Source : rlshop.gg' });

  // Boutons par onglet (max 25 boutons = 5 lignes de 5)
  const rows = [];
  for (let i = 0; i < tabs.length && i < 25; i += 5) {
    const row = new ActionRowBuilder();
    tabs.slice(i, i + 5).forEach(t => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`shop_tab_${t.tab}`)
          .setLabel(t.tab)
          .setStyle(ButtonStyle.Primary)
      );
    });
    rows.push(row);
  }

  await channel.send({ embeds: [embed], components: rows });
  console.log(`✅ Shop envoyé — ${totalItems} items, ${tabs.length} onglets`);
}

// ── Tracker Rocket League ─────────────────────────────────────────────────

// Emojis custom par rang (nom:id)
const RANK_EMOJIS = {
  'Bronze I':            '<:Bronze1:643180472804966400>',
  'Bronze II':           '<:Bronze2:643180466240749568>',
  'Bronze III':          '<:Bronze3:1472035459583574077>',
  'Silver I':            '<:Argent1:643180450461909032>',
  'Silver II':           '<:Argent2:643180441926631445>',
  'Silver III':          '<:Argent3:643180434007785493>',
  'Gold I':              '<:Or1:643180410246791213>',
  'Gold II':             '<:Or2:643180399370960946>',
  'Gold III':            '<:Or3:643180390986547200>',
  'Platinum I':          '<:Platine1:643180373337178112>',
  'Platinum II':         '<:Platine2:643180361613967379>',
  'Platinum III':        '<:Platine3:643180352910917662>',
  'Diamond I':           '<:Diamant1:643180330412539915>',
  'Diamond II':          '<:Diamant2:1472041347786735697>',
  'Diamond III':         '<:Diamant3:1472041508072067216>',
  'Champion I':          '<:Champion1:643180293448007680>',
  'Champion II':         '<:Champion2:643180282857521163>',
  'Champion III':        '<:Champion3:643180274175180820>',
  'Grand Champion I':    '<:grandchampion1:1465401214199140434>',
  'Grand Champion II':   '<:GrandChampion2:758821306170343464>',
  'Grand Champion III':  '<:GrandChampion3:758821325321011260>',
  'Supersonic Legend':   '<:SupersonicLegend:758821358993408020>',
};

function getRankEmoji(rankName) {
  if (!rankName) return '❓';
  // Correspondance exacte
  if (RANK_EMOJIS[rankName]) return RANK_EMOJIS[rankName];
  // Correspondance insensible à la casse
  const lower = rankName.toLowerCase();
  for (const [key, emoji] of Object.entries(RANK_EMOJIS)) {
    if (key.toLowerCase() === lower) return emoji;
  }
  // Correspondance partielle
  for (const [key, emoji] of Object.entries(RANK_EMOJIS)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) return emoji;
  }
  return '❓';
}

// Thumbnail du rang pour l'embed
const RANK_THUMBNAILS = {
  'Bronze':           'https://trackercdn.com/cdn/tracker.gg/rocket-league/ranks/1.png',
  'Silver':           'https://trackercdn.com/cdn/tracker.gg/rocket-league/ranks/4.png',
  'Gold':             'https://trackercdn.com/cdn/tracker.gg/rocket-league/ranks/7.png',
  'Platinum':         'https://trackercdn.com/cdn/tracker.gg/rocket-league/ranks/10.png',
  'Diamond':          'https://trackercdn.com/cdn/tracker.gg/rocket-league/ranks/13.png',
  'Champion':         'https://trackercdn.com/cdn/tracker.gg/rocket-league/ranks/16.png',
  'Grand Champion':   'https://trackercdn.com/cdn/tracker.gg/rocket-league/ranks/19.png',
  'Supersonic Legend':'https://trackercdn.com/cdn/tracker.gg/rocket-league/ranks/22.png',
};

function getRankThumbnail(rankName) {
  if (!rankName) return null;
  for (const [key, url] of Object.entries(RANK_THUMBNAILS)) {
    if (rankName.toLowerCase().includes(key.toLowerCase())) return url;
  }
  return null;
}

const PLATFORM_MAP = {
  'epic':  'Epic Games',
  'steam': 'Steam',
  'psn':   'PlayStation',
  'xbl':   'Xbox',
};

async function fetchTrackerStats(platform, username) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    const url = `https://rocketleague.tracker.network/rocket-league/profile/${platform}/${encodeURIComponent(username)}/overview`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      if (text.includes('PLAYER NOT FOUND') || text.includes('could not find')) {
        return { error: 'Joueur introuvable.' };
      }

      const nameEl = document.querySelector('h1');
      const name = nameEl ? nameEl.innerText.trim().split('\n')[0] : '';
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      // Convertit MMR en rang
      function mmrToRank(mmr) {
        const n = parseInt(String(mmr).replace(/,/g, ''));
        if (isNaN(n)) return '';
        if (n < 92)   return 'Bronze I';
        if (n < 183)  return 'Bronze II';
        if (n < 275)  return 'Bronze III';
        if (n < 358)  return 'Silver I';
        if (n < 441)  return 'Silver II';
        if (n < 524)  return 'Silver III';
        if (n < 581)  return 'Gold I';
        if (n < 638)  return 'Gold II';
        if (n < 695)  return 'Gold III';
        if (n < 762)  return 'Platinum I';
        if (n < 829)  return 'Platinum II';
        if (n < 895)  return 'Platinum III';
        if (n < 962)  return 'Diamond I';
        if (n < 1028) return 'Diamond II';
        if (n < 1095) return 'Diamond III';
        if (n < 1162) return 'Champion I';
        if (n < 1228) return 'Champion II';
        if (n < 1295) return 'Champion III';
        if (n < 1395) return 'Grand Champion I';
        if (n < 1495) return 'Grand Champion II';
        if (n < 1595) return 'Grand Champion III';
        return 'Supersonic Legend';
      }

      const modes = {
        '1v1': 'RANKED DUEL 1V1',
        '2v2': 'RANKED DOUBLES 2V2',
        '3v3': 'RANKED STANDARD 3V3',
      };

      const ranks = {};
      for (const [key, label] of Object.entries(modes)) {
        const idx = lines.findIndex(l => l === label);
        if (idx === -1) continue;
        // Current MMR est 2 lignes après
        const currentIdx = lines.findIndex((l, i) => i > idx && l === 'Current');
        if (currentIdx !== -1 && lines[currentIdx + 1]) {
          const mmr = lines[currentIdx + 1].replace(/,/g, '');
          if (/^\d+$/.test(mmr)) {
            ranks[key] = { rank: mmrToRank(mmr), mmr };
          }
        }
      }

      // Peak rank — cherche "Peak Rating" puis le MMR le plus haut
      let peakRank = '', peakMmr = '', peakSeason = '';
      const peakIdx = lines.findIndex(l => l === 'Peak Rating');
      if (peakIdx !== -1) {
        // Cherche le rang juste après
        for (let i = peakIdx + 1; i < Math.min(peakIdx + 15, lines.length); i++) {
          const rankMatch = lines[i].match(/^(Bronze|Silver|Gold|Platinum|Diamond|Champion|Grand Champion|Supersonic Legend)\s*(I{0,3}V?I{0,3})?/i);
          if (rankMatch && !peakRank) {
            peakRank = rankMatch[2] ? `${rankMatch[1]} ${rankMatch[2].trim()}` : rankMatch[1];
          }
          const mmrMatch = lines[i].match(/^([\d,]{3,7})$/);
          if (mmrMatch && !peakMmr) peakMmr = mmrMatch[1].replace(/,/g, '');
          const seasonMatch = lines[i].match(/Season (\d+)/i);
          if (seasonMatch) peakSeason = seasonMatch[1];
          if (peakRank && peakMmr) break;
        }
      }

      // Fallback : peak depuis la section du haut (ligne 23 environ)
      if (!peakMmr) {
        // Cherche le premier MMR numérique après "Ranked X 2v2" ou similaire
        const firstModeIdx = lines.findIndex(l => /Ranked (Duel|Doubles|Standard)/.test(l));
        if (firstModeIdx > 0 && lines[firstModeIdx + 1]) {
          const m = lines[firstModeIdx + 1].replace(/,/g, '');
          if (/^\d+$/.test(m)) peakMmr = m;
          if (peakMmr) peakRank = mmrToRank(peakMmr);
        }
      }

      return { name, ranks, peakRank, peakMmr, peakSeason };
    });

    return data;
  } finally {
    await browser.close();
  }
}

function buildTrackerMessage() {
  const embed = new EmbedBuilder()
    .setTitle('🎮 Tracker Rocket League')
    .setDescription('Sélectionne ta plateforme puis entre ton nom de joueur.')
    .setColor(0x5865f2)
    .setImage(WELCOME_IMAGE);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('tracker_epic').setLabel('Epic Games').setEmoji('🖥️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('tracker_steam').setLabel('Steam').setEmoji('🎮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tracker_psn').setLabel('PlayStation').setEmoji('🎮').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('tracker_xbl').setLabel('Xbox').setEmoji('🎮').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

async function setupTrackerMessage(guild) {
  const channel = guild.channels.cache.get(TRACKER_CHANNEL_ID);
  if (!channel) { console.error('❌ Salon tracker introuvable.'); return; }

  const messages = await channel.messages.fetch({ limit: 20 });
  const existing = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Tracker Rocket League'));
  if (existing) { console.log('ℹ️ Message tracker déjà présent.'); return; }

  await channel.send(buildTrackerMessage());
  console.log('✅ Message tracker envoyé.');
}

// ── Démarrage ─────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}`);

  // Démarre le panel web
  startPanel(client, audioPlayers, 3001);

  const commands = [
    new SlashCommandBuilder()
      .setName('live')
      .setDescription('Envoie une annonce de live TikTok en DM à tous les membres')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Joue une musique YouTube dans ton salon vocal')
      .addStringOption(opt => opt.setName('url').setDescription('URL YouTube').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Arrête la musique et vide la file')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('Passe à la musique suivante')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Affiche la file d\'attente')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('leave')
      .setDescription('Fait quitter le bot du salon vocal')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('mute')
      .setDescription('Rend un membre muet')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.MuteMembers)
      .addUserOption(opt => opt.setName('utilisateur').setDescription('Membre à muter').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('unmute')
      .setDescription('Retire le mute d\'un membre')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.MuteMembers)
      .addUserOption(opt => opt.setName('utilisateur').setDescription('Membre à démuter').setRequired(true))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Expulse un membre du serveur')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers)
      .addUserOption(opt => opt.setName('utilisateur').setDescription('Membre à expulser').setRequired(true))
      .addStringOption(opt => opt.setName('raison').setDescription('Raison').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Supprime des messages dans le salon')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
      .addIntegerOption(opt => opt.setName('nombre').setDescription('Nombre de messages à supprimer (1-100)').setRequired(true).setMinValue(1).setMaxValue(100))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Bannir un utilisateur')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers)
      .addUserOption(opt => opt.setName('utilisateur').setDescription('Le membre à bannir').setRequired(true))
      .addStringOption(opt => opt.setName('raison').setDescription('Raison du ban').setRequired(false))
      .toJSON(),
    new SlashCommandBuilder()
      .setName('unban')
      .setDescription('Débannir un utilisateur')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('guessmyrankvideo')
      .setDescription('Publier une vidéo dans Guess My Rank')
      .addStringOption(opt => opt.setName('rang').setDescription('Le vrai rang (ex: Platine II)').setRequired(true))
      .addAttachmentOption(opt => opt.setName('video').setDescription('Vidéo ou image à publier').setRequired(false))
      .addStringOption(opt => opt.setName('url').setDescription('URL de la vidéo (si pas de fichier)').setRequired(false))
      .toJSON(),
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  for (const guild of client.guilds.cache.values()) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands })
      .then(() => console.log(`✅ Commande /live enregistrée sur ${guild.name}`))
      .catch(console.error);
  }

  for (const guild of client.guilds.cache.values()) {
    await guild.members.fetch();
    await guild.roles.fetch();
    await setupRankMessage(guild);
    await setupChannelPermissions(guild);
    // await sendShop(guild); // désactivé
    await setupTrackerMessage(guild);
    await setupGmrMessage(guild);
  }

  // Envoi automatique du shop tous les jours à 19h00 UTC (shop RL se renouvelle à cette heure)
  cron.schedule('0 19 * * *', async () => {
    console.log('🕖 Mise à jour automatique du shop...');
    for (const guild of client.guilds.cache.values()) {
      await sendShop(guild);
    }
  }, { timezone: 'UTC' });
});

// ── Bienvenue ─────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  const role = member.guild.roles.cache.get(AUTO_ROLE_ID);
  if (role) await member.roles.add(role).catch((err) => console.error(`❌ Rôle : ${err.message}`));

  const channel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setTitle(`Bienvenue ${member.user.username} !`)
    .setDescription(`Content de t'accueillir, **${member.user.username}** !\n\nVa dans le salon **#rôles** pour choisir ton rang et ta plateforme.`)
    .setImage(WELCOME_IMAGE)
    .setColor(0x5865f2)
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setFooter({ text: `Membre #${member.guild.memberCount}` })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
});

// ── Interactions ──────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // /live
  if (interaction.isChatInputCommand() && interaction.commandName === 'live') {
    if (interaction.user.id !== LIVE_ALLOWED_USER) {
      return interaction.reply({ content: '❌ Permission refusée.', ephemeral: true });
    }

    await interaction.reply({ content: '📨 Envoi en cours...', ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle('🔴 Wallter est en LIVE sur TikTok !')
      .setDescription(`**Wallter_RL** est en live !\n\n🎮 ${TIKTOK_URL}`)
      .setColor(0xff0050)
      .setImage(WELCOME_IMAGE)
      .setTimestamp();

    const members = await interaction.guild.members.fetch();
    let envoyes = 0, echecs = 0;
    for (const member of members.values()) {
      if (member.user.bot) continue;
      try { await member.send({ embeds: [embed] }); envoyes++; }
      catch { echecs++; }
    }

    await interaction.editReply({ content: `✅ ${envoyes} DM(s) envoyé(s), ${echecs} échec(s).` });
    console.log(`📢 /live — ${envoyes} DMs envoyés, ${echecs} échecs.`);
    return;
  }

  // Vérification Owner/Fondateur pour les commandes admin
  const ADMIN_COMMANDS = ['ban', 'unban', 'kick', 'mute', 'unmute', 'clear'];
  if (interaction.isChatInputCommand() && ADMIN_COMMANDS.includes(interaction.commandName)) {
    const allowedRoles = ['1522018910948425889', '1522019388264546314']; // Owner, Fondateur
    const hasRole = allowedRoles.some(r => interaction.member.roles.cache.has(r));
    if (!hasRole) return interaction.reply({ content: '❌ Réservé aux Owner et Fondateur.', ephemeral: true });
  }

  // /guessmyrankvideo
  if (interaction.isChatInputCommand() && interaction.commandName === 'guessmyrankvideo') {
    const rankInput  = interaction.options.getString('rang');
    const attachment = interaction.options.getAttachment('video');
    const urlInput   = interaction.options.getString('url');

    const rank = findGmrRank(rankInput);
    if (!rank) return interaction.reply({ content: `❌ Rang invalide. Ex: \`b1\`, \`p2\`, \`gc3\`, \`ssl\`, \`Platine II\`...`, ephemeral: true });

    const mediaUrl = attachment?.url || urlInput;
    if (!mediaUrl) return interaction.reply({ content: '❌ Fournis une vidéo (fichier joint) ou une URL.', ephemeral: true });

    const data = loadGmrData();
    data.videos.push({
      url:     mediaUrl,
      rank:    rank.label,
      emoji:   rank.emoji,
      addedBy: interaction.user.id,
      addedAt: Date.now(),
    });
    saveGmrData(data);

    // Poste dans le salon GMR
    const gmrChannel = interaction.guild.channels.cache.get(GMR_CHANNEL_ID);
    if (gmrChannel) {
      const embed = new EmbedBuilder()
        .setTitle('📤 Nouvelle vidéo ajoutée !')
        .setDescription(`**${interaction.user.username}** a ajouté une vidéo.\nRang masqué — joue pour deviner !\n\n${mediaUrl}`)
        .setColor(0x5865f2)
        .setFooter({ text: `Total : ${data.videos.length} vidéo(s)` });
      await gmrChannel.send({ embeds: [embed] });
    }

    await interaction.reply({ content: `✅ Vidéo publiée avec le rang **${rank.emoji} ${rank.label}** !`, ephemeral: true });
    return;
  }
  if (interaction.isChatInputCommand() && interaction.commandName === 'ban') {
    const allowedRoles = ['1522018910948425889', '1522019388264546314']; // Owner, Fondateur
    const hasRole = allowedRoles.some(r => interaction.member.roles.cache.has(r));
    if (!hasRole) {
      return interaction.reply({ content: '❌ Seuls les Owner et Fondateur peuvent utiliser cette commande.', ephemeral: true });
    }
    const target = interaction.options.getUser('utilisateur');
    const raison  = interaction.options.getString('raison') || 'Aucune raison fournie';

    try {
      await interaction.guild.members.ban(target.id, { reason: raison, deleteMessageSeconds: 604800 });
      await interaction.reply({ content: `✅ **${target.username}** a été banni.\nRaison : **${raison}**`, ephemeral: true });
      console.log(`🔨 Ban : ${target.tag} — ${raison}`);
    } catch (err) {
      await interaction.reply({ content: `❌ Impossible de bannir : ${err.message}`, ephemeral: true });
    }
    return;
  }

  // /unban
  if (interaction.isChatInputCommand() && interaction.commandName === 'unban') {
    const allowedRoles = ['1522018910948425889', '1522019388264546314']; // Owner, Fondateur
    const hasRole = allowedRoles.some(r => interaction.member.roles.cache.has(r));
    if (!hasRole) {
      return interaction.reply({ content: '❌ Seuls les Owner et Fondateur peuvent utiliser cette commande.', ephemeral: true });
    }

    // Récupère la liste des bannis
    const bans = await interaction.guild.bans.fetch();
    if (bans.size === 0) {
      return interaction.reply({ content: 'Aucun membre banni sur ce serveur.', ephemeral: true });
    }

    // Affiche un menu déroulant avec les 25 premiers bannis
    const options = bans.first(25).map(ban => ({
      label: ban.user.username,
      description: `ID : ${ban.user.id}`,
      value: ban.user.id,
    }));

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('unban_select')
        .setPlaceholder('Choisir un membre à débannir')
        .addOptions(options)
    );

    await interaction.reply({ content: `**${bans.size}** membre(s) banni(s). Sélectionne celui à débannir :`, components: [row], ephemeral: true });
    return;
  }

  // Menu déroulant unban
  if (interaction.isStringSelectMenu() && interaction.customId === 'unban_select') {
    const allowedRoles = ['1522018910948425889', '1522019388264546314'];
    const hasRole = allowedRoles.some(r => interaction.member.roles.cache.has(r));
    if (!hasRole) return interaction.reply({ content: '❌ Permission refusée.', ephemeral: true });

    const id = interaction.values[0];
    try {
      const ban = await interaction.guild.bans.fetch(id);
      await interaction.guild.bans.remove(id);
      await interaction.update({ content: `✅ **${ban.user.username}** a été débanni.`, components: [] });
      console.log(`✅ Unban : ${ban.user.tag}`);
    } catch (err) {
      await interaction.update({ content: `❌ Erreur : ${err.message}`, components: [] });
    }
    return;
  }

  // ── GMR Modal soumise ──
  if (interaction.isModalSubmit() && interaction.customId === 'gmr_publish_modal') {
    const videoUrl = interaction.fields.getTextInputValue('gmr_video_url').trim();
    const rankInput = interaction.fields.getTextInputValue('gmr_rank').trim();
    const rank = findGmrRank(rankInput);
    if (!rank) return interaction.reply({ content: `❌ Rang invalide. Ex: \`b1\`, \`p2\`, \`gc3\`, \`ssl\``, ephemeral: true });

    const data = loadGmrData();
    data.videos.push({ url: videoUrl, rank: rank.label, emoji: rank.emoji, addedBy: interaction.user.id, addedAt: Date.now() });
    saveGmrData(data);

    // Poste dans le salon GMR
    const gmrChannel = interaction.guild.channels.cache.get(GMR_CHANNEL_ID);
    if (gmrChannel) {
      const embed = new EmbedBuilder()
        .setTitle('📤 Nouvelle vidéo ajoutée !')
        .setDescription(`**${interaction.user.username}** a ajouté une vidéo.\nRang masqué — joue pour deviner !\n\n${videoUrl}`)
        .setColor(0x5865f2)
        .setFooter({ text: `Total : ${data.videos.length} vidéo(s)` });
      await gmrChannel.send({ embeds: [embed] });
    }

    await interaction.reply({ content: `✅ Vidéo publiée avec le rang **${rank.emoji} ${rank.label}** !`, ephemeral: true });
    return;
  }

  // ── Modal TRACKER soumise ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith('tracker_search_')) {
    const platform  = interaction.customId.replace('tracker_search_', '');
    const username  = interaction.fields.getTextInputValue('tracker_username').trim();

    await interaction.reply({ content: `🔍 Recherche de **${username}** sur ${PLATFORM_MAP[platform] || platform}...`, ephemeral: true });

    let stats;
    try {
      stats = await fetchTrackerStats(platform, username);
    } catch (err) {
      return interaction.editReply({ content: `❌ Erreur lors de la recherche : ${err.message}` });
    }

    if (stats.error) return interaction.editReply({ content: `❌ ${stats.error}` });

    const peakImg = getRankThumbnail(stats.peakRank);

    const embed = new EmbedBuilder()
      .setTitle(`${stats.name || username} — Stats Rocket League`)
      .setColor(0x5865f2)
      .setFooter({ text: `${PLATFORM_MAP[platform] || platform} • Source : tracker.gg` });

    if (peakImg) embed.setThumbnail(peakImg);

    if (stats.peakRank) {
      const peakEmoji = getRankEmoji(stats.peakRank);
      const peakThumb = getRankThumbnail(stats.peakRank);
      if (peakThumb) embed.setThumbnail(peakThumb);
      embed.addFields({
        name: '🏆 Peak Rank',
        value: `${peakEmoji} **${stats.peakRank}**${stats.peakMmr ? ` — ${stats.peakMmr} MMR` : ''}${stats.peakSeason ? ` *(Saison ${stats.peakSeason})*` : ''}`,
        inline: false,
      });
    }

    const modes = [
      { key: '1v1', label: '1v1' },
      { key: '2v2', label: '2v2' },
      { key: '3v3', label: '3v3' },
    ];

    for (const mode of modes) {
      const r = stats.ranks?.[mode.key];
      const emoji = r ? getRankEmoji(r.rank) : '';
      embed.addFields({
        name: mode.label,
        value: r ? `${emoji} **${r.rank}**\n${r.mmr} MMR` : 'Non classé',
        inline: true,
      });
    }

    await interaction.editReply({ content: '', embeds: [embed] });
    return;
  }

  if (!interaction.isButton()) return;

  // ── Boutons GMR ──
  if (interaction.customId === 'gmr_play') {
    const data = loadGmrData();
    if (data.videos.length < 1) return interaction.reply({ content: '❌ Aucune vidéo disponible. Publie-en une avec **📤 Publier** !', ephemeral: true });
    const shuffled = [...data.videos].sort(() => Math.random() - 0.5).slice(0, 5);
    gmrSessions.set(interaction.user.id, { videos: shuffled, index: 0, score: 0 });
    const video = shuffled[0];
    const embed = new EmbedBuilder()
      .setTitle('🎮 Guess My Rank — Vidéo 1/5')
      .setDescription(`**Quel est le rang de ce joueur ?**\n\n🎬 ${video.url}`)
      .setColor(0x5865f2)
      .setFooter({ text: `Score : 0 | ${interaction.user.username}` });
    await interaction.reply({ embeds: [embed], components: buildGmrRankButtons(), ephemeral: true });
    return;
  }

  if (interaction.customId === 'gmr_publish') {
    await interaction.reply({
      content: '📤 Pour publier une vidéo, utilise la commande :\n`/guessmyrankvideo rang:p2 video:[ta vidéo]`\n\nTu peux joindre directement ta vidéo comme fichier ou mettre une URL.',
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === 'gmr_leaderboard') {
    const data = loadGmrData();
    const sorted = Object.entries(data.scores)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const medals = ['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
    const lines = sorted.length > 0
      ? sorted.map(([id, pts], i) => `${medals[i]} <@${id}> — **${pts} point${pts > 1 ? 's' : ''}**`).join('\n')
      : 'Aucun score pour l\'instant.';
    const embed = new EmbedBuilder()
      .setTitle('🏆 Leaderboard — Guess My Rank')
      .setDescription(lines)
      .setColor(0xf0b232);
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  // Réponse aux boutons de rang GMR
  if (interaction.customId.startsWith('gmr_') && GMR_RANKS.find(r => r.id === interaction.customId)) {
    const session = gmrSessions.get(interaction.user.id);
    if (!session) return interaction.reply({ content: '❌ Lance une partie avec **▶ Play** !', ephemeral: true });

    const chosen = GMR_RANKS.find(r => r.id === interaction.customId);
    const current = session.videos[session.index];
    const correct = chosen.label === current.rank;
    if (correct) session.score++;
    session.index++;

    if (session.index >= session.videos.length) {
      // Fin de partie
      const data = loadGmrData();
      if (!data.scores[interaction.user.id]) data.scores[interaction.user.id] = 0;
      data.scores[interaction.user.id] += session.score;
      saveGmrData(data);
      gmrSessions.delete(interaction.user.id);

      const embed = new EmbedBuilder()
        .setTitle('🎮 Fin de partie !')
        .setDescription(`${correct ? '✅ Bonne réponse !' : `❌ Mauvais rang ! C'était **${current.emoji} ${current.rank}**`}\n\n**Score final : ${session.score}/5**\n\nTon total : **${data.scores[interaction.user.id]} points**`)
        .setColor(session.score >= 4 ? 0x23a55a : session.score >= 2 ? 0xf0b232 : 0xf23f43);

      await interaction.update({ embeds: [embed], components: [] });
    } else {
      // Prochaine vidéo
      const next = session.videos[session.index];
      const embed = new EmbedBuilder()
        .setTitle(`🎮 Guess My Rank — Vidéo ${session.index + 1}/5`)
        .setDescription(`${correct ? '✅ Bonne réponse !' : `❌ C'était **${current.emoji} ${current.rank}**`}\n\n**Quel est le rang de ce joueur ?**\n\n🎬 ${next.url}`)
        .setColor(0x5865f2)
        .setFooter({ text: `Score : ${session.score} | ${interaction.user.username}` });
      await interaction.update({ embeds: [embed], components: buildGmrRankButtons() });
    }
    return;
  }

  // ── Boutons TRACKER plateforme ──
  if (interaction.customId.startsWith('tracker_') && !interaction.customId.startsWith('tracker_search_')) {
    const platform = interaction.customId.replace('tracker_', '');
    const modal = new ModalBuilder()
      .setCustomId(`tracker_search_${platform}`)
      .setTitle(`Recherche ${PLATFORM_MAP[platform] || platform}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('tracker_username')
          .setLabel('Nom du joueur')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: Wallter_RL')
          .setRequired(true)
      )
    );
    await interaction.showModal(modal);
    return;
  }
  if (interaction.customId.startsWith('shop_tab_')) {
    const tabName = interaction.customId.replace('shop_tab_', '');
    let tabs = [];
    try { tabs = await getShopTabs(); }
    catch { return interaction.reply({ content: '❌ Erreur shop.', ephemeral: true }); }

    const tab = tabs.find(t => t.tab === tabName);
    if (!tab || tab.items.length === 0) {
      return interaction.reply({ content: 'Aucun item dans cet onglet.', ephemeral: true });
    }

    const embeds = tab.items.map(item => {
      const paintStr = item.paint ? ` — ${item.paint}` : '';
      return new EmbedBuilder()
        .setTitle(`${item.name}${paintStr}`)
        .setDescription(`**${item.price} crédits**`)
        .setThumbnail(item.img || null)
        .setColor(CAT_COLORS[tabName] ?? 0x5865f2);
    });

    await interaction.reply({ embeds: embeds.slice(0, 10), ephemeral: true });
    return;
  }

  const member = interaction.member;
  const guild  = interaction.guild;

  // Rang
  const rank = RANKS.find((r) => r.id === interaction.customId);
  if (rank) {
    pendingRank.set(member.id, rank.id);
    const allRankRoleIds = Object.values(rankRoleIds);
    const toRemove = member.roles.cache.filter((r) => allRankRoleIds.includes(r.id));
    if (toRemove.size > 0) await member.roles.remove(toRemove).catch(() => {});
    const roleId = rankRoleIds[rank.id];
    if (roleId) await member.roles.add(roleId).catch(() => {});

    const embed = new EmbedBuilder()
      .setTitle(`Rang ${rank.name} sélectionné !`)
      .setDescription('Choisis maintenant ta plateforme 🎮')
      .setColor(rank.color);

    await interaction.reply({ embeds: [embed], components: buildPlatformButtons(), ephemeral: true });
    return;
  }

  // Plateforme
  const platform = PLATFORMS.find((p) => p.id === interaction.customId);
  if (platform) {
    const allPlatRoleIds = Object.values(platformRoleIds);
    const toRemove = member.roles.cache.filter((r) => allPlatRoleIds.includes(r.id));
    if (toRemove.size > 0) await member.roles.remove(toRemove).catch(() => {});
    const roleId = platformRoleIds[platform.id];
    if (roleId) await member.roles.add(roleId).catch(() => {});

    const wallterRole = guild.roles.cache.get(AUTO_ROLE_ID);
    if (wallterRole && member.roles.cache.has(AUTO_ROLE_ID)) {
      await member.roles.remove(wallterRole).catch(() => {});
    }

    pendingRank.delete(member.id);
    const rankId   = [...Object.entries(rankRoleIds)].find(([, v]) => member.roles.cache.has(v))?.[0];
    const rankName = RANKS.find((r) => r.id === rankId)?.name ?? 'inconnu';

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle('✅ Configuration terminée !')
          .setDescription(`Rang : **${rankName}**\nPlateforme : **${platform.name}**\n\nBienvenue ! Tu as accès à tous les salons.`)
          .setColor(0x57f287),
      ],
      components: [],
    });
    return;
  }
});

// ── Anti-spam + Anti-lien ─────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

  if (LINK_REGEX.test(message.content)) {
    const hasAllowedRole = LINK_ALLOWED_ROLES.some((id) => member.roles.cache.has(id));
    if (hasAllowedRole) return;
    await message.delete().catch(() => {});
    await timeoutMember(member, TIMEOUT_LINK);
    console.log(`🔗 Lien → timeout 5 min : ${message.author.tag}`);
    return;
  }

  const userId = message.author.id;
  if (!spamMap.has(userId)) spamMap.set(userId, { count: 0, resetTimer: null });
  const data = spamMap.get(userId);
  data.count++;
  if (data.resetTimer) clearTimeout(data.resetTimer);
  data.resetTimer = setTimeout(() => spamMap.delete(userId), SPAM_WINDOW);

  if (data.count > SPAM_THRESHOLD_HEAVY) {
    spamMap.delete(userId);
    await purgeRecentMessages(message.channel, userId);
    await timeoutMember(member, TIMEOUT_SPAM_HEAVY);
    console.log(`🚨 Spam extrême → purge + timeout 1h : ${message.author.tag}`);
  } else if (data.count > SPAM_THRESHOLD_LIGHT) {
    spamMap.delete(userId);
    await purgeRecentMessages(message.channel, userId);
    await timeoutMember(member, TIMEOUT_SPAM_LIGHT);
    console.log(`⚠️ Spam → purge + timeout 1 min : ${message.author.tag}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
