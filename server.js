// server.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const multiparty = require('multiparty');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));






// DB functions
async function getAllTickets() {
  const { data, error } = await supabase
    .from('tickets')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

async function createTicket(ticket) {
  const { data, error } = await supabase
    .from('tickets')
    .insert([ticket])
    .select();

  if (error) throw error;
  return data[0];
}

async function updateTicketStatus(id, status) {
  try {
    const allowedStatuses = ['Not Checked', 'In Progress', 'Solved'];
    if (!allowedStatuses.includes(status)) {
      throw new Error(`Invalid status: ${status}. Allowed values: ${allowedStatuses.join(', ')}`);
    }

    if (isNaN(Number(id))) {
      throw new Error(`Invalid ticket ID: ${id}`);
    }

    const { data, error } = await supabase
      .from('tickets')
      .update({ 
        status: status
        // Remove updated_at from here
      })
      .eq('id', id)
      .select();
    
    if (error) throw error;

    if (!data || data.length === 0) {
      throw new Error(`Ticket with ID ${id} not found`);
    }

    return data[0];
  } catch (error) {
    console.error('Error updating ticket status:', {
      id,
      status,
      error: error.message
    });
    throw error;
  }
}

async function deleteTicket(id) {
  try {
    // 1. Get the ticket to find the screenshot reference
    const { data: ticket, error: fetchError } = await supabase
      .from('tickets')
      .select('screenshot')
      .eq('id', id)
      .single();

    if (fetchError) throw fetchError;
    if (!ticket) throw new Error('Ticket not found');

    // 2. Delete the screenshot if it exists
    if (ticket.screenshot) {
      try {
        // Extract the file path from the URL (more robust method)
        const url = new URL(ticket.screenshot);
        const filePath = url.pathname.split('/').pop();
        
        // Delete from storage
        const { error: deleteError } = await supabase.storage
          .from('ticket-screenshots')
          .remove([filePath]);

        if (deleteError) {
          console.warn(`Failed to delete screenshot for ticket ${id}:`, deleteError.message);
          // Continue with ticket deletion even if screenshot deletion fails
        } else {
          console.log(`Deleted screenshot for ticket ${id}`);
        }
      } catch (error) {
        console.warn(`Error processing screenshot deletion for ticket ${id}:`, error.message);
      }
    }

    // 3. Delete the ticket record
    const { error: deleteTicketError } = await supabase
      .from('tickets')
      .delete()
      .eq('id', id);

    if (deleteTicketError) throw deleteTicketError;

    console.log(`Successfully deleted ticket ${id}`);
    return true;
  } catch (error) {
    console.error(`Error deleting ticket ${id}:`, error.message);
    throw error; // Re-throw for the calling function to handle
  }
}

// Initialize bucket
async function initializeStorage() {
  try {
    const { data: buckets, error } = await supabase.storage.listBuckets();
    if (error) throw error;

    const bucketExists = buckets.some(b => b.name === 'ticket-screenshots');

    if (!bucketExists) {
      const { error: createError } = await supabase.storage.createBucket('ticket-screenshots', {
        public: true,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
        fileSizeLimit: 10 * 1024 * 1024 // 10MB
      });
      if (createError) throw createError;
    }
  } catch (error) {
    console.error('Storage initialization error:', error);
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// API
app.get('/api/tickets', async (req, res) => {
  try {
    const tickets = await getAllTickets();
    res.json(tickets);
  } catch (error) {
    console.error('Error fetching tickets:', error);
    res.status(500).json({ error: 'Failed to fetch tickets' });
  }
});


app.delete('/api/tickets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await deleteTicket(id);
    res.json({ success: true });
    
    // Notify WebSocket clients
    req.app.locals.wss.broadcast(JSON.stringify({
      type: 'TICKET_DELETED',
      id: id
    }));
  } catch (error) {
    console.error('Error deleting ticket:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to delete ticket',
      details: error.details 
    });
  }
});


app.patch('/api/tickets/:id', async (req, res) => {
  try {
    const ticketId = parseInt(req.params.id);
    const { status } = req.body;
    
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const updatedTicket = await updateTicketStatus(ticketId, status);
    res.json({ success: true, ticket: updatedTicket });
    
  } catch (error) {
    console.error('Route error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to update ticket status',
      details: error.details // Supabase often provides additional error details
    });
  }
});











app.post('/api/tickets', async (req, res) => {
  try {
    const formData = await new Promise((resolve, reject) => {
      const form = new multiparty.Form();
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        resolve({ fields, files });
      });
    });

    let screenshotUrl = null;

    if (formData.files.screenshot && formData.files.screenshot[0]) {
      const file = formData.files.screenshot[0];
      const fileExt = path.extname(file.originalFilename);
      const fileName = `screenshot-${Date.now()}${fileExt}`;

      // Solution 1: Read file into buffer
      const fileBuffer = await fsp.readFile(file.path);
      
      const { data, error } = await supabase.storage
        .from('ticket-screenshots')
        .upload(fileName, fileBuffer, {
          contentType: file.headers['content-type'],
          upsert: false,
          duplex: 'half' // Required for Node.js 18+
        });

      if (error) throw error;

      const { data: { publicUrl } } = supabase.storage
        .from('ticket-screenshots')
        .getPublicUrl(data.path);

      screenshotUrl = publicUrl;
      await fsp.unlink(file.path);
    }

    const newTicket = {
      name: formData.fields.name[0],
      location: formData.fields.location[0],
      department: formData.fields.department[0],
      description: formData.fields.description[0],
      urgency: formData.fields.urgency[0],
      status: 'Not Checked',
      screenshot: screenshotUrl
    };

    const createdTicket = await createTicket(newTicket);
    
    req.app.locals.wss.broadcast(JSON.stringify({
      type: 'NEW_TICKET',
      ticket: createdTicket
    }));
    
    res.json({ success: true, ticket: createdTicket });
  } catch (error) {
    console.error('Error creating ticket:', error);
    res.status(500).json({ error: error.message || 'Failed to create ticket' });
  }
});
// Start server
async function startServer() {
  await initializeStorage();

  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
  });

  // WebSocket setup
  const wss = new WebSocket.Server({ server });
  app.locals.wss = wss;

  wss.broadcast = function (data) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  };

  wss.on('connection', (ws) => {
    console.log('New WebSocket connection');
    ws.on('close', () => console.log('WebSocket disconnected'));
  });
}

startServer().catch(console.error);
