// Friend Contact Tracker Backend
// This app helps you stay in touch with friends by suggesting who to contact

const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// Environment variables you'll need to set:
// GOOGLE_SERVICE_ACCOUNT_EMAIL - from your Google API credentials
// GOOGLE_PRIVATE_KEY - from your Google API credentials  
// SHEET_ID - your Google Sheet ID
// ANTHROPIC_API_KEY - your Claude API key

const SHEET_ID = process.env.SHEET_ID;
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Initialize Google Sheets connection
async function getSheet() {
  const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  return doc.sheetsByIndex[0]; // Use first sheet
}

// Get your current location from the sheet
async function getMyLocation(sheet) {
  await sheet.loadCells('A1:B1'); // Load the location cell
  const locationCell = sheet.getCellByA1('B1');
  return locationCell.value || 'NYC';
}

// Get all friends from the sheet
async function getFriends(sheet) {
  const rows = await sheet.getRows();
  return rows.map(row => ({
    name: row.get('Name'),
    location: row.get('Location'),
    lastContact: row.get('Last Contact') ? new Date(row.get('Last Contact')) : null,
    rowIndex: row.rowNumber
  })).filter(f => f.name); // Filter out empty rows
}

// Calculate days since last contact
function daysSince(date) {
  if (!date) return Infinity;
  const now = new Date();
  const diff = now - date;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// Determine if it's a local or non-local day (alternates)
async function isLocalDay(sheet) {
  await sheet.loadCells('D1'); // Track alternation state
  const stateCell = sheet.getCellByA1('D1');
  const lastWasLocal = stateCell.value === 'local';
  return !lastWasLocal; // Alternate
}

// Update alternation state
async function setAlternationState(sheet, isLocal) {
  await sheet.loadCells('D1');
  const stateCell = sheet.getCellByA1('D1');
  stateCell.value = isLocal ? 'local' : 'non-local';
  await sheet.saveUpdatedCells();
}

// GET /daily-suggestion
// Returns the friend to contact today
app.get('/daily-suggestion', async (req, res) => {
  try {
    const sheet = await getSheet();
    const myLocation = await getMyLocation(sheet);
    const friends = await getFriends(sheet);
    const shouldBeLocal = await isLocalDay(sheet);

    // Separate local and non-local friends
    const localFriends = friends.filter(f => f.location === myLocation);
    const nonLocalFriends = friends.filter(f => f.location !== myLocation);

    // Pick from appropriate group (oldest first)
    const targetGroup = shouldBeLocal ? localFriends : nonLocalFriends;
    
    if (targetGroup.length === 0) {
      return res.json({
        message: `No ${shouldBeLocal ? 'local' : 'non-local'} friends in your list!`,
        suggestion: null
      });
    }

    targetGroup.sort((a, b) => {
      const daysA = daysSince(a.lastContact);
      const daysB = daysSince(b.lastContact);
      return daysB - daysA; // Oldest first
    });

    const suggestion = targetGroup[0];
    const days = daysSince(suggestion.lastContact);
    
    // Update alternation state for next time
    await setAlternationState(sheet, shouldBeLocal);
    
    // Store last suggestion so we know what "yes" means
    await sheet.loadCells('E1');
    const lastSuggestedCell = sheet.getCellByA1('E1');
    lastSuggestedCell.value = suggestion.name;
    await sheet.saveUpdatedCells();

    res.json({
      name: suggestion.name,
      location: suggestion.location,
      daysSince: days === Infinity ? 'never' : days,
      isLocal: shouldBeLocal,
      message: `Reach out to ${suggestion.name} (${suggestion.location}, ${days === Infinity ? 'never contacted' : `${days} days ago`})`
    });
  } catch (error) {
    console.error('Error getting suggestion:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /process-reply
// Processes natural language reply from Slack
app.post('/process-reply', async (req, res) => {
  try {
    const { message } = req.body;
    
    const sheet = await getSheet();
    
    // Get the last suggested name from the sheet (might be null if no suggestion yet)
    await sheet.loadCells('E1');
    const lastSuggestedCell = sheet.getCellByA1('E1');
    const suggestedName = lastSuggestedCell.value || '';
    
    const friends = await getFriends(sheet);
    
    // Use Claude to parse the user's intent
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are helping parse user messages about contacting friends. ${suggestedName ? `The user was last suggested to contact "${suggestedName}".` : 'The user is proactively logging a contact.'}

User's message: "${message}"

Parse this and respond with ONLY a JSON object (no markdown, no explanation) with these fields:
- action: "log_suggested" | "log_other" | "skip" | "get_next"
- friendName: name of friend to log (if logging someone, extract it from the message)
- date: date string if they mentioned a specific date (format: YYYY-MM-DD), or null for today

Examples:
"yes" -> {"action": "log_suggested", "friendName": null, "date": null}
"I texted Sarah" -> {"action": "log_other", "friendName": "Sarah", "date": null}
"I actually texted Sarah yesterday" -> {"action": "log_other", "friendName": "Sarah", "date": "YYYY-MM-DD"} (use yesterday's date)
"skip this one" -> {"action": "skip", "friendName": null, "date": null}
"give me someone else" -> {"action": "get_next", "friendName": null, "date": null}
"I talked to John on Tuesday" -> {"action": "log_other", "friendName": "John", "date": "YYYY-MM-DD"} (calculate Tuesday's date)
"talked to Mike last Thursday" -> {"action": "log_other", "friendName": "Mike", "date": "YYYY-MM-DD"} (calculate last Thursday's date)

If the message is just logging someone without mentioning the suggested person, use "log_other" with the friendName.

Current date: ${new Date().toISOString().split('T')[0]}`
      }]
    });

    const parsed = JSON.parse(response.content[0].text);
    
    let responseMessage = '';
    
    if (parsed.action === 'log_suggested' && suggestedName) {
      // Log the suggested friend
      const friend = friends.find(f => f.name === suggestedName);
      if (friend) {
        const rows = await sheet.getRows();
        const row = rows.find(r => r.get('Name') === suggestedName);
        row.set('Last Contact', parsed.date || new Date().toISOString().split('T')[0]);
        await row.save();
        responseMessage = `✓ Logged contact with ${suggestedName}`;
      }
    } else if (parsed.action === 'log_other' || (parsed.action === 'log_suggested' && !suggestedName)) {
      // Log a specific friend (either they named someone, or said "yes" but there's no suggestion)
      const friendName = parsed.friendName || suggestedName;
      const friend = friends.find(f => 
        f.name.toLowerCase() === friendName.toLowerCase()
      );
      
      if (friend) {
        const rows = await sheet.getRows();
        const row = rows.find(r => r.get('Name') === friend.name);
        row.set('Last Contact', parsed.date || new Date().toISOString().split('T')[0]);
        await row.save();
        responseMessage = `✓ Logged contact with ${friend.name}`;
      } else {
        responseMessage = `Couldn't find "${friendName}" in your list. Did you spell it right?`;
      }
    } else if (parsed.action === 'skip' || parsed.action === 'get_next') {
      // Get next suggestion
      const myLocation = await getMyLocation(sheet);
      const shouldBeLocal = await isLocalDay(sheet);
      const localFriends = friends.filter(f => f.location === myLocation && f.name !== suggestedName);
      const nonLocalFriends = friends.filter(f => f.location !== myLocation && f.name !== suggestedName);
      const targetGroup = shouldBeLocal ? localFriends : nonLocalFriends;
      
      if (targetGroup.length > 0) {
        targetGroup.sort((a, b) => daysSince(b.lastContact) - daysSince(a.lastContact));
        const next = targetGroup[0];
        const days = daysSince(next.lastContact);
        responseMessage = `How about ${next.name}? (${next.location}, ${days === Infinity ? 'never contacted' : `${days} days ago`})`;
        
        // Update stored suggestion
        lastSuggestedCell.value = next.name;
        await sheet.saveUpdatedCells();
      } else {
        responseMessage = `No other ${shouldBeLocal ? 'local' : 'non-local'} friends to suggest today!`;
      }
    }
    
    res.json({ message: responseMessage });
  } catch (error) {
    console.error('Error processing reply:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Friend Contact Tracker is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
