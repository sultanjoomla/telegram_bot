const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'tickets.json');

// Ensure the file exists on first run
function ensureFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
  }
}

// Load all tickets: { userId: [ {ticketId, ...}, ... ] }
function loadTickets() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('Failed to read tickets.json, starting fresh:', err.message);
    return {};
  }
}

// Save all tickets back to disk
function saveTickets(data) {
  ensureFile();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to write tickets.json:', err.message);
  }
}

// Append one ticket for a given user
function addTicket(userId, ticket) {
  const data = loadTickets();
  if (!data[userId]) data[userId] = [];
  data[userId].push(ticket);
  saveTickets(data);
  return ticket;
}

// Get all tickets for a given user
function getTicketsForUser(userId) {
  const data = loadTickets();
  return data[userId] || [];
}

// Update a ticket's status by ticketId (searches across all users)
function updateTicketStatus(ticketId, status) {
  const data = loadTickets();
  for (const userId in data) {
    const ticket = data[userId].find(t => t.ticketId === ticketId);
    if (ticket) {
      ticket.status = status;
      saveTickets(data);
      return ticket;
    }
  }
  return null;
}

module.exports = {
  loadTickets,
  saveTickets,
  addTicket,
  getTicketsForUser,
  updateTicketStatus,
};
