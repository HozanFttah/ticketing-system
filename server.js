const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const multiparty = require('multiparty');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

// Initialize Supabase clients
const supabaseUrl = 'https://ysdtxbipmslwjitdidez.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzZHR4YmlwbXNsd2ppdGRpZGV6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0ODQyMjM3NywiZXhwIjoyMDYzOTk4Mzc3fQ.11uriA-UP-8_6mWYHTf3jBp1QBTzf98Y_fvTqVEEXOE';

const supabaseAnonKey= 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzZHR4YmlwbXNsd2ppdGRpZGV6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg0MjIzNzcsImV4cCI6MjA2Mzk5ODM3N30.Cz5cNZnCFZHCltJB68OW3C-lGInAvPPumGPOojzm4v8';

// Admin client for server-side operations
const supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

// Function to create user-specific client
function createUserClient(accessToken) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'https://*.onrender.com'
  ],
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD', 'DELETE'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Authentication middleware
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'Unauthorized - No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const userClient = createUserClient(token);
    const { data: { user }, error } = await userClient.auth.getUser();

    if (error || !user) {
      return res.status(401).json({ error: 'Unauthorized - Invalid token' });
    }

    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    console.error('Authentication error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// Auth endpoints
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    // Check if email ends with @drd-me.org
    if (!email.endsWith('@drd-me.org')) {
      return res.status(403).json({ 
        error: 'Only emails from @drd-me.org domain are allowed' 
      });
    }

    const { data, error } = await supabaseAdmin.auth.signUp({
      email,
      password
    });

    if (error) throw error;
    res.json({ success: true, message: 'Please check your email for verification link' });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    // Check if email ends with @drd-me.org
    if (!email.endsWith('@drd-me.org')) {
      return res.status(403).json({ 
        error: 'Only emails from @drd-me.org domain are allowed' 
      });
    }

    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;
    res.json({ 
      success: true, 
      user: data.user,
  session: data.session  // contains refresh_token, access_token, expires_at
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/auth/logout', authenticate, async (req, res) => {
  try {
    const userClient = createUserClient(req.token);
    const { error } = await userClient.auth.signOut();
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Failed to logout' });
  }
});

app.get('/api/auth/user', authenticate, async (req, res) => {
  try {
    res.json({ user: req.user });
  } catch (err) {
    console.error('User fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    const { data, error } = await supabaseAdmin.auth.refreshSession({ refresh_token });

    if (error) throw error;
    res.json({ session: data.session });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(401).json({ error: 'Failed to refresh session' });
  }
});


// DB functions
async function getAllTickets() {
  const { data, error } = await supabaseAdmin
    .from('tickets')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
}

async function createTicket(ticket, accessToken) {
  const userClient = createUserClient(accessToken);
  const { data, error } = await userClient
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

    const { data, error } = await supabaseAdmin
      .from('tickets')
      .update({ 
        status: status
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
    const { data: ticket, error: fetchError } = await supabaseAdmin
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
        const { error: deleteError } = await supabaseAdmin.storage
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
    const { error: deleteTicketError } = await supabaseAdmin
      .from('tickets')
      .delete()
      .eq('id', id);

    if (deleteTicketError) throw deleteTicketError;

    console.log(`Successfully deleted ticket ${id}`);
    return true;
  } catch (error) {
    console.error(`Error deleting ticket ${id}:`, error.message);
    throw error;
  }
}

// Initialize bucket
async function initializeStorage() {
  try {
    const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();
    if (error) throw error;

    const bucketExists = buckets.some(b => b.name === 'ticket-screenshots');

    if (!bucketExists) {
      const { error: createError } = await supabaseAdmin.storage.createBucket('ticket-screenshots', {
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
      details: error.details
    });
  }
});

app.post('/api/tickets', authenticate, async (req, res) => {
  if (!req.user || !req.user.id) {
    console.warn("Missing or invalid user ID");
    return res.status(401).json({ error: "Invalid user session" });
  }

  let formData;
  try {
    formData = await new Promise((resolve, reject) => {
      const form = new multiparty.Form();
      
      // Add error handling for form parsing
      form.on('error', (err) => {
        console.error('Form parsing error:', err);
        reject(err);
      });
      
      form.parse(req, (err, fields, files) => {
        if (err) {
          console.error('Form parse error:', err);
          reject(err);
          return;
        }
        resolve({ fields, files });
      });
    });
  } catch (err) {
    console.error('Error parsing form data:', err);
    return res.status(400).json({ error: 'Invalid form data' });
  }

  let screenshotUrl = null;
  let tempFilePath = null;

  try {
    if (formData.files.screenshot && formData.files.screenshot[0]) {
      const file = formData.files.screenshot[0];
      const fileExt = path.extname(file.originalFilename);
      const fileName = `screenshot-${Date.now()}${fileExt}`;
      tempFilePath = file.path;

      const fileBuffer = await fsp.readFile(file.path);

	const userClient = createUserClient(req.token); // uses anon key + auth header

      
      const { data, error } = await userClient.storage
        .from('ticket-screenshots')
        .upload(fileName, fileBuffer, {
          contentType: file.headers['content-type'],
          upsert: false,
          duplex: 'half'
        });

      if (error) {
        console.error('Supabase upload error:', error);
        throw error;
      }

      const { data: { publicUrl } } = userClient.storage
        .from('ticket-screenshots')
        .getPublicUrl(data.path);

      screenshotUrl = publicUrl;
    }

    const newTicket = {
      name: formData.fields.name[0],
      phone: formData.fields.phone[0],
      location: formData.fields.location[0],
      department: formData.fields.department[0],
      description: formData.fields.description[0],
      urgency: formData.fields.urgency[0],
      status: 'Not Checked',
      screenshot: screenshotUrl,
      user_id: req.user.id
    };

    const createdTicket = await createTicket(newTicket, req.token);
    return res.json({ success: true, ticket: createdTicket });
    
  } catch (error) {
    console.error('Error creating ticket:', error);
    
    // Clean up temporary files if they exist
    if (tempFilePath) {
      try {
        await fsp.unlink(tempFilePath).catch(cleanupErr => {
          console.warn('Failed to cleanup temp file:', cleanupErr);
        });
      } catch (cleanupErr) {
        console.warn('Error during temp file cleanup:', cleanupErr);
      }
    }
    
    // Handle specific Supabase errors
    if (error.message.includes('RLS')) {
      console.error('RLS policy violation detected:', error);
      return res.status(403).json({ 
        error: 'Permission denied. Please try again or contact support.',
        details: 'RLS policy violation'
      });
    }
    
    return res.status(500).json({ 
      error: error.message || 'Failed to create ticket',
      details: error.details 
    });
  } finally {
    // Ensure temporary files are cleaned up
    if (formData.files.screenshot && formData.files.screenshot[0]) {
      const file = formData.files.screenshot[0];
      if (file.path && file.path !== tempFilePath) {
        try {
          await fsp.unlink(file.path).catch(cleanupErr => {
            console.warn('Failed to cleanup additional temp file:', cleanupErr);
          });
        } catch (cleanupErr) {
          console.warn('Error during additional temp file cleanup:', cleanupErr);
        }
      }
    }
  }
});

// Start server
async function startServer() {
  await initializeStorage();

  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 Admin panel: http://localhost:${PORT}/admin`);
  });
}

startServer().catch(console.error);
