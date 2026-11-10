import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INITIAL_TRANSACTIONS, INITIAL_PICS, INITIAL_TASKS } from './src/mockData.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'cashflow_db.json');

// Ensure data folder exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory state initialized with disk file or defaults
let dbState = {
  transactions: [] as any[],
  pics: INITIAL_PICS,
  tasks: INITIAL_TASKS as any[]
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.transactions && Array.isArray(parsed.transactions)) {
      // Filter out legacy sample transactions if present
      const isLegacy = parsed.transactions.some((t: any) => t.id === 'trx-101' || t.id === 'trx-102');
      if (isLegacy) {
        dbState.transactions = [];
        dbState.pics = INITIAL_PICS;
        dbState.tasks = INITIAL_TASKS;
        fs.writeFileSync(DB_FILE, JSON.stringify(dbState, null, 2), 'utf-8');
      } else {
        dbState.transactions = parsed.transactions;
        dbState.pics = parsed.pics || INITIAL_PICS;
        dbState.tasks = parsed.tasks || INITIAL_TASKS;
      }
    }
  } catch (err) {
    console.warn('Could not read existing db file, using initial data:', err);
  }
} else {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbState, null, 2), 'utf-8');
  } catch (err) {
    console.warn('Could not save initial db file:', err);
  }
}

function persistDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(dbState, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to write db file:', err);
  }
}

// SSE Clients Registry
interface SseClient {
  id: string;
  picName: string;
  res: express.Response;
}

let sseClients: SseClient[] = [];

function broadcastTransactionUpdate(action: string, transaction: any) {
  const payload = JSON.stringify({ type: 'TRANSACTIONS_UPDATED', action, transaction });
  sseClients.forEach(client => {
    try {
      client.res.write(`data: ${payload}\n\n`);
    } catch (e) {
      // client disconnected
    }
  });
}

function broadcastTaskUpdate(action: 'create' | 'update' | 'delete' | 'status', task: any) {
  const payload = JSON.stringify({ type: 'TASKS_UPDATED', action, task });
  sseClients.forEach(client => {
    try {
      client.res.write(`data: ${payload}\n\n`);
    } catch (e) {
      // client disconnected
    }
  });
}

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  app.use(express.json());

  // --- API Routes ---

  // Auth login
  app.post('/api/auth/login', (req, res) => {
    const { username, password, picName } = req.body;
    
    // Check credentials as requested:
    // Pic 1 (utama) yg bisa memberikan perintah penugasan ke Pic 2 dll
    // Username : Kiki
    // Password : Ki88ki
    if (username.trim().toLowerCase() === 'kiki' && password === 'Ki88ki') {
      return res.json({
        success: true,
        user: {
          id: 'pic-1',
          username: 'Kiki',
          nama: 'PIC 1 - Kiki',
          role: 'PIC 1 (Utama) - Koordinator & Pemberi Tugas'
        }
      });
    }

    // Support Nabila as Finance PIC:
    // Username : Nabila
    // Password : Na88bila
    if (username.trim().toLowerCase() === 'nabila' && password === 'Na88bila') {
      return res.json({
        success: true,
        user: {
          id: 'pic-nabila',
          username: 'Nabila',
          nama: picName || 'Nabila',
          role: 'Lead Finance & Kasir'
        }
      });
    }

    // Support team staff accounts (with master password Ki88ki or Na88bila)
    if (password === 'Ki88ki' || password === 'Na88bila') {
      return res.json({
        success: true,
        user: {
          id: `pic-${username}`,
          username: username,
          nama: picName || username,
          role: 'Petugas PIC Travel'
        }
      });
    }

    return res.status(401).json({
      success: false,
      message: 'Username atau Password salah. (PIC 1 Utama -> Username: Kiki, Password: Ki88ki)'
    });
  });

  // Get all PICs
  app.get('/api/pics', (req, res) => {
    res.json(dbState.pics);
  });

  // Register / Add PIC
  app.post('/api/pics', (req, res) => {
    const { nama, role } = req.body;
    if (!nama) return res.status(400).json({ error: 'Nama PIC wajib diisi' });

    const existing = dbState.pics.find(p => p.nama.toLowerCase() === nama.trim().toLowerCase());
    if (existing) {
      existing.online = true;
      existing.lastActive = 'Baru saja';
      persistDb();
      return res.json(existing);
    }

    const newPic = {
      id: `pic-${Date.now()}`,
      username: nama.trim(),
      nama: nama.trim(),
      role: role || 'Staff Operasional Umroh',
      avatarColor: 'bg-emerald-600',
      online: true,
      lastActive: 'Baru saja'
    };
    dbState.pics.push(newPic);
    persistDb();
    res.json(newPic);
  });

  // Update existing PIC (for PIC 3, 4, 5 manual editing)
  app.put('/api/pics/:id', (req, res) => {
    const { id } = req.params;
    const { nama, role } = req.body;
    const pic = dbState.pics.find(p => p.id === id);
    if (!pic) return res.status(404).json({ error: 'PIC tidak ditemukan' });
    if (nama) pic.nama = nama.trim();
    if (role) pic.role = role.trim();
    persistDb();
    res.json(pic);
  });

  // Transactions CRUD
  app.get('/api/transactions', (req, res) => {
    res.json(dbState.transactions);
  });

  app.post('/api/transactions', (req, res) => {
    const data = req.body;
    if (!data.amount || !data.category) {
      return res.status(400).json({ error: 'Nominal dan Kategori wajib diisi' });
    }

    const newTrx = {
      id: `trx-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: data.type || 'income',
      stage: data.stage || (data.type === 'income' ? 'dp1' : 'expense'),
      category: data.category,
      amount: Number(data.amount),
      namaJamaah: data.namaJamaah ? data.namaJamaah.trim() : '',
      nomorPassport: data.nomorPassport ? data.nomorPassport.trim() : '',
      namaAgent: data.namaAgent ? data.namaAgent.trim() : '',
      tanggalBerangkat: data.tanggalBerangkat || '',
      pindahTanggal: data.pindahTanggal || '',
      transactionDate: data.transactionDate || new Date().toISOString(),
      isManualDate: !!data.isManualDate,
      keterangan: data.keterangan || '',
      metodePembayaran: data.metodePembayaran || 'Transfer Bank BSI',
      pic: data.pic || 'Nabila',
      picRole: data.picRole || 'Petugas PIC',
      createdAt: new Date().toISOString()
    };

    dbState.transactions.unshift(newTrx);
    persistDb();
    broadcastTransactionUpdate('create', newTrx);
    res.json(newTrx);
  });

  app.put('/api/transactions/:id', (req, res) => {
    const { id } = req.params;
    const index = dbState.transactions.findIndex(t => t.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    }

    const current = dbState.transactions[index];
    const updated = {
      ...current,
      ...req.body,
      amount: Number(req.body.amount || current.amount),
      updatedAt: new Date().toISOString(),
      lastEditedByPic: req.body.editorPic || current.pic
    };

    dbState.transactions[index] = updated;
    persistDb();
    broadcastTransactionUpdate('update', updated);
    res.json(updated);
  });

  app.delete('/api/transactions/:id', (req, res) => {
    const { id } = req.params;
    const index = dbState.transactions.findIndex(t => t.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
    }

    const deleted = dbState.transactions.splice(index, 1)[0];
    persistDb();
    broadcastTransactionUpdate('delete', deleted);
    res.json({ success: true, deletedId: id });
  });

  // --- Task Notes / Perintah Penugasan PIC ---
  // Get all tasks (supports filtering by assignedTo, assignedBy, or status)
  app.get('/api/tasks', (req, res) => {
    const { assignedTo, assignedBy, status } = req.query as {
      assignedTo?: string;
      assignedBy?: string;
      status?: string;
    };

    let list = [...(dbState.tasks || [])];
    if (assignedTo && assignedTo !== 'all') {
      list = list.filter(t => t.assignedToPic === assignedTo);
    }
    if (assignedBy && assignedBy !== 'all') {
      list = list.filter(t => t.assignedByPic === assignedBy);
    }
    if (status && status !== 'all') {
      list = list.filter(t => t.status === status);
    }

    // Sort: pending first, urgent first, then newest
    list.sort((a, b) => {
      if (a.status !== b.status) {
        if (a.status === 'pending') return -1;
        if (b.status === 'pending') return 1;
        if (a.status === 'in_progress') return -1;
        if (b.status === 'in_progress') return 1;
      }
      if (a.priority !== b.priority) {
        if (a.priority === 'urgent') return -1;
        if (b.priority === 'urgent') return 1;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    res.json(list);
  });

  // Create new task assignment note
  app.post('/api/tasks', (req, res) => {
    const {
      title,
      detail,
      assignedByPic,
      assignedToPic,
      priority,
      deadline,
      transactionRefId,
      transactionRefSummary
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Judul perintah penugasan wajib diisi' });
    }
    if (!assignedToPic) {
      return res.status(400).json({ error: 'Penerima tugas (PIC) wajib dipilih' });
    }

    const newTask = {
      id: `task-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      title: title.trim(),
      detail: (detail || '').trim(),
      assignedByPic: assignedByPic || 'Nabila',
      assignedToPic: assignedToPic.trim(),
      priority: priority || 'normal',
      status: 'pending',
      deadline: deadline || '',
      transactionRefId: transactionRefId || '',
      transactionRefSummary: transactionRefSummary || '',
      createdAt: new Date().toISOString()
    };

    if (!dbState.tasks) dbState.tasks = [];
    dbState.tasks.unshift(newTask);
    persistDb();
    broadcastTaskUpdate('create', newTask);
    res.json(newTask);
  });

  // Edit task note
  app.put('/api/tasks/:id', (req, res) => {
    const { id } = req.params;
    const index = (dbState.tasks || []).findIndex(t => t.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Catatan penugasan tidak ditemukan' });
    }

    const current = dbState.tasks[index];
    const updated = {
      ...current,
      ...req.body,
      title: req.body.title ? req.body.title.trim() : current.title,
      detail: req.body.detail !== undefined ? req.body.detail.trim() : current.detail,
      updatedAt: new Date().toISOString()
    };

    dbState.tasks[index] = updated;
    persistDb();
    broadcastTaskUpdate('update', updated);
    res.json(updated);
  });

  // Update status (pending <-> in_progress <-> completed)
  app.patch('/api/tasks/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const task = (dbState.tasks || []).find(t => t.id === id);
    if (!task) {
      return res.status(404).json({ error: 'Catatan penugasan tidak ditemukan' });
    }

    task.status = status;
    task.updatedAt = new Date().toISOString();
    if (status === 'completed') {
      task.completedAt = new Date().toISOString();
    } else {
      delete task.completedAt;
    }

    persistDb();
    broadcastTaskUpdate('status', task);
    res.json(task);
  });

  // Delete task note
  app.delete('/api/tasks/:id', (req, res) => {
    const { id } = req.params;
    const index = (dbState.tasks || []).findIndex(t => t.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'Catatan penugasan tidak ditemukan' });
    }

    const deleted = dbState.tasks.splice(index, 1)[0];
    persistDb();
    broadcastTaskUpdate('delete', deleted);
    res.json({ success: true, deletedId: id });
  });

  // Post text reply to a task (from PIC 2, 3, 4, 5, etc. to PIC 1)
  app.post('/api/tasks/:id/replies', (req, res) => {
    const { id } = req.params;
    const { text, senderPic, senderRole } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Teks balasan wajib diisi' });
    }

    const task = (dbState.tasks || []).find(t => t.id === id);
    if (!task) {
      return res.status(404).json({ error: 'Catatan penugasan tidak ditemukan' });
    }

    if (!task.replies) task.replies = [];

    const newReply = {
      id: `reply-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      senderPic: senderPic || 'PIC',
      senderRole: senderRole || 'Petugas',
      text: text.trim(),
      createdAt: new Date().toISOString()
    };

    task.replies.push(newReply);
    task.updatedAt = new Date().toISOString();
    persistDb();
    broadcastTaskUpdate('update', task);
    res.json({ success: true, task, reply: newReply });
  });

  // SSE Real-time Endpoint
  app.get('/api/events', (req, res) => {
    const pic = (req.query.pic as string) || 'Anonymous';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', pic })}\n\n`);

    const clientId = `${Date.now()}-${Math.random()}`;
    const newClient: SseClient = { id: clientId, picName: pic, res };
    sseClients.push(newClient);

    req.on('close', () => {
      sseClients = sseClients.filter(c => c.id !== clientId);
    });
  });

  // Integrate Vite dev middleware
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Cashflow Umroh Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
