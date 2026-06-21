const TelegramBot = require('node-telegram-bot-api')
const cron = require('node-cron')
const storage = require('./storage')
require('dotenv').config()

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true })

// ─── CONFIG ───────────────────────────────────────────────
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID // e.g. -100123456789
const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID // where new tickets get posted for admins

// Anti-spam tracker: { userId: { count, lastTime } }
const spamTracker = {}
const SPAM_LIMIT = 5
const SPAM_WINDOW_MS = 5000
const MUTE_DURATION = 60

// ─── HELPER: Check Admin ──────────────────────────────────
async function isAdmin(chatId, userId) {
  const admins = await bot.getChatAdministrators(chatId)
  return admins.some((a) => a.user.id === userId)
}

// ─── 1. WELCOME MESSAGE ───────────────────────────────────
bot.on('new_chat_members', async (msg) => {
  const chatId = msg.chat.id

  for (const newMember of msg.new_chat_members) {
    const firstName = newMember.first_name || 'Member'
    const username = newMember.username ? `@${newMember.username}` : firstName

    const welcome = `
🎉 *Welcome, ${username}!*

We're glad to have you in *${msg.chat.title}*!

📜 Please read our rules: /rules
💬 Introduce yourself and say hi!
🤖 Type /help to see available commands.
    `

    try {
      await bot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' })
    } catch (err) {
      console.error('Welcome message error:', err.message)
    }
  }
})

// ─── 2. ANTI-SPAM ─────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id
  const userId = msg.from?.id
  if (!userId) return

  // Only apply anti-spam in group chats, skip admins
  if (msg.chat.type === 'private') return
  if (await isAdmin(chatId, userId)) return

  const now = Date.now()

  if (!spamTracker[userId]) {
    spamTracker[userId] = { count: 1, lastTime: now }
    return
  }

  const tracker = spamTracker[userId]
  const timeDiff = now - tracker.lastTime

  if (timeDiff < SPAM_WINDOW_MS) {
    tracker.count++

    if (tracker.count >= SPAM_LIMIT) {
      try {
        await bot.deleteMessage(chatId, msg.message_id)

        const unmuteTime = Math.floor(Date.now() / 1000) + MUTE_DURATION
        await bot.restrictChatMember(chatId, userId, {
          permissions: { can_send_messages: false },
          until_date: unmuteTime,
        })

        await bot.sendMessage(
          chatId,
          `🚫 @${
            msg.from.username || msg.from.first_name
          } has been muted for ${MUTE_DURATION}s due to spamming.`,
        )

        spamTracker[userId] = { count: 0, lastTime: now }
      } catch (err) {
        console.error('Anti-spam error:', err.message)
      }
    }
  } else {
    spamTracker[userId] = { count: 1, lastTime: now }
  }
})

// ─── 3. SCHEDULED ANNOUNCEMENTS ───────────────────────────
cron.schedule('0 8 * * *', () => {
  bot.sendMessage(
    GROUP_CHAT_ID,
    `☀️ *Good morning, everyone!*\n\nHave a productive day! 💪\nRemember to follow the group rules. /rules`,
    { parse_mode: 'Markdown' },
  )
})

cron.schedule('0 20 * * *', () => {
  bot.sendMessage(
    GROUP_CHAT_ID,
    `🌙 *Good evening!*\n\nThanks for being active today. See you tomorrow! 😊`,
    { parse_mode: 'Markdown' },
  )
})

cron.schedule('0 9 * * 1', () => {
  bot.sendMessage(
    GROUP_CHAT_ID,
    `📅 *Weekly Reminder*\n\n✅ Stay respectful\n✅ No spam\n✅ Share valuable content\n\nLet's have a great week!`,
    { parse_mode: 'Markdown' },
  )
})

// ─── 4. BASIC COMMANDS ─────────────────────────────────────
bot.onText(/^\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 Welcome! I'm the group bot. Type /help to see commands.`,
  )
})

bot.onText(/^\/help/, (msg) => {
  const help = `
📋 *Available Commands:*
/rules - Show group rules
/ticket - Open a support ticket
/mytickets - View your submitted tickets
/warn @user - Warn a member (admin)
/kick - Remove a member (admin, reply to their message)
  `
  bot.sendMessage(msg.chat.id, help, { parse_mode: 'Markdown' })
})

bot.onText(/^\/rules/, (msg) => {
  const rules = `
📜 *Group Rules:*
1. Be respectful
2. No spam
3. Stay on topic
4. No NSFW content
  `
  bot.sendMessage(msg.chat.id, rules, { parse_mode: 'Markdown' })
})

bot.onText(/^\/warn(?:\s+@(\w+))?/, async (msg, match) => {
  const chatId = msg.chat.id
  if (!(await isAdmin(chatId, msg.from.id)))
    return bot.sendMessage(chatId, '⛔ Admins only.')
  if (!match[1]) return bot.sendMessage(chatId, 'Usage: /warn @username')
  bot.sendMessage(chatId, `⚠️ @${match[1]} has been warned!`)
})

bot.onText(/^\/kick/, async (msg) => {
  const chatId = msg.chat.id
  if (!(await isAdmin(chatId, msg.from.id)))
    return bot.sendMessage(chatId, '⛔ Admins only.')

  if (msg.reply_to_message) {
    const userId = msg.reply_to_message.from.id
    await bot.banChatMember(chatId, userId)
    await bot.unbanChatMember(chatId, userId)
    bot.sendMessage(chatId, `✅ User has been kicked.`)
  } else {
    bot.sendMessage(chatId, "Reply to a user's message to kick them.")
  }
})

// ─── 5. SUPPORT TICKET FORM ────────────────────────────────
const ticketState = {} // { userId: { step, answers: {}, chatId } } — in-progress forms only

const TICKET_STEPS = [
  'name',
  'email',
  'phone',
  'country',
  'subject',
  'coin',
  'amount',
  'description',
]

const TICKET_PROMPTS = {
  name: "👤 What's your full name?",
  email: "📧 What's your email address?",
  phone: "📱 What's your phone number? (include country code, e.g. +234...)",
  country: '🌍 Which country are you in?',
  subject: "📌 What's the subject of your ticket? (short summary)",
  coin: '🪙 Which coin/token is this related to? (e.g. BTC, ETH, USDT)',
  amount: '💰 What amount is involved? (numeric value, e.g. 0.5)',
  description: '📝 Please describe the issue in detail:',
}

bot.onText(/^\/ticket/, (msg) => {
  const userId = msg.from.id
  ticketState[userId] = { step: 0, answers: {}, chatId: msg.chat.id }

  bot.sendMessage(
    msg.chat.id,
    '🎫 *Open a Support Ticket*\n\n' +
      'This form is for record-keeping only — it does not send or move any funds. ' +
      'Your information is used only to process your ticket and is not shared.\n\n' +
      TICKET_PROMPTS.name,
    { parse_mode: 'Markdown' },
  )
})

bot.on('message', (msg) => {
  const userId = msg.from.id
  const state = ticketState[userId]

  if (!state) return
  if (!msg.text || msg.text.startsWith('/')) return

  const currentKey = TICKET_STEPS[state.step]
  const value = msg.text.trim()

  // Validation
  if (currentKey === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return bot.sendMessage(
      state.chatId,
      "⚠️ That doesn't look like a valid email. Try again:",
    )
  }
  if (currentKey === 'phone' && !/^\+?[0-9]{7,15}$/.test(value)) {
    return bot.sendMessage(
      state.chatId,
      "⚠️ That doesn't look like a valid phone number. Try again (e.g. +2348012345678):",
    )
  }
  if (currentKey === 'amount' && !/^[0-9]*\.?[0-9]+$/.test(value)) {
    return bot.sendMessage(
      state.chatId,
      '⚠️ Please enter a numeric amount (e.g. 0.5):',
    )
  }
  if (currentKey === 'coin' && value.length > 10) {
    return bot.sendMessage(
      state.chatId,
      '⚠️ Please enter a valid coin symbol (e.g. BTC, ETH):',
    )
  }

  state.answers[currentKey] = value
  state.step++

  if (state.step < TICKET_STEPS.length) {
    const nextKey = TICKET_STEPS[state.step]
    bot.sendMessage(state.chatId, TICKET_PROMPTS[nextKey])
  } else {
    const ticketId = 'TKT-' + Date.now().toString(36).toUpperCase()
    const timestamp = new Date().toISOString()

    const summary = `
✅ *Ticket Submitted*

🎫 Ticket ID: ${ticketId}
👤 Name: ${state.answers.name}
📧 Email: ${state.answers.email}
📱 Phone: ${state.answers.phone}
🌍 Country: ${state.answers.country}
📌 Subject: ${state.answers.subject}
🪙 Coin: ${state.answers.coin}
💰 Amount: ${state.answers.amount}
📝 Description: ${state.answers.description}
    `
    bot.sendMessage(state.chatId, summary, { parse_mode: 'Markdown' })

    // Notify support/admin channel
    bot.sendMessage(
      SUPPORT_CHAT_ID,
      `🚨 *New Support Ticket* ${ticketId}\n${summary}`,
      { parse_mode: 'Markdown' },
    )

    // Persist to disk
    storage.addTicket(userId, {
      ticketId,
      status: 'open',
      timestamp,
      ...state.answers,
    })

    console.log('Ticket submitted:', { ticketId, userId, ...state.answers })

    delete ticketState[userId]
  }
})

// /mytickets - view your submitted tickets (reads from disk)
bot.onText(/^\/mytickets/, (msg) => {
  const userId = msg.from.id
  const tickets = storage.getTicketsForUser(userId)

  if (!tickets || tickets.length === 0) {
    return bot.sendMessage(
      msg.chat.id,
      'You have no submitted tickets yet. Use /ticket to open one.',
    )
  }

  const list = tickets
    .map(
      (t) => `
🎫 *${t.ticketId}* — ${t.status}
📌 ${t.subject}
🗓️ ${new Date(t.timestamp).toLocaleString()}
  `,
    )
    .join('\n')

  bot.sendMessage(msg.chat.id, `📋 *Your Tickets:*\n${list}`, {
    parse_mode: 'Markdown',
  })
})

// /closeticket <id> - admin only, updates ticket status
bot.onText(/^\/closeticket\s+(\S+)/, async (msg, match) => {
  const chatId = msg.chat.id
  if (!(await isAdmin(chatId, msg.from.id)))
    return bot.sendMessage(chatId, '⛔ Admins only.')

  const ticketId = match[1]
  const updated = storage.updateTicketStatus(ticketId, 'closed')

  if (updated) {
    bot.sendMessage(chatId, `✅ Ticket ${ticketId} marked as closed.`)
  } else {
    bot.sendMessage(chatId, `⚠️ No ticket found with ID ${ticketId}.`)
  }
})

// ─── ERROR HANDLING ───────────────────────────────────────
bot.on('polling_error', (err) => console.error('Polling error:', err.message))

console.log('🤖 Bot is running...')
