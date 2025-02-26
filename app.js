// File: app.js - Main application setup
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const session = require('express-session');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Configure middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.set('view engine', 'ejs');

// Configure session
app.use(session({
  secret: 'blog-platform-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true in production with HTTPS
}));

// Configure multer for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed'));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Database connection
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'blogplatform',
  password: 'postgres',
  port: 5432,
});

// Check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.session.userId) {
    return next();
  }
  res.redirect('/login');
};

// Routes

// Home page
app.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.id, b.title, b.summary, b.created_at, u.username, p.name as publication_name
      FROM blogs b
      JOIN publications p ON b.publication_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE b.status = 'published'
      ORDER BY b.created_at DESC
      LIMIT 10
    `);
    
    res.render('index', { 
      blogs: result.rows,
      user: req.session.userId ? { id: req.session.userId, username: req.session.username } : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Login page
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const result = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );
    
    if (result.rows.length > 0 && result.rows[0].password_hash === password) {
      req.session.userId = result.rows[0].id;
      req.session.username = result.rows[0].username;
      res.redirect('/dashboard');
    } else {
      res.render('login', { error: 'Invalid username or password' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Register page
app.get('/register', (req, res) => {
  res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  
  try {
    // Check if username already exists
    const checkResult = await pool.query(
      'SELECT id FROM users WHERE username = $1 OR email = $2',
      [username, email]
    );
    
    if (checkResult.rows.length > 0) {
      return res.render('register', { error: 'Username or email already exists' });
    }
    
    // Insert new user
    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id',
      [username, email, password] // In a real app, password should be hashed
    );
    
    req.session.userId = result.rows[0].id;
    req.session.username = username;
    
    // Create default publication for user
    await pool.query(
      'INSERT INTO publications (user_id, name, description, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())',
      [result.rows[0].id, `${username}'s Publication`, 'My personal blog']
    );
    
    res.redirect('/dashboard');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Dashboard
app.get('/dashboard', isAuthenticated, async (req, res) => {
  try {
    // Get user's publications
    const publicationsResult = await pool.query(
      'SELECT id, name FROM publications WHERE user_id = $1',
      [req.session.userId]
    );
    
    // Get user's blogs
    const blogsResult = await pool.query(`
      SELECT b.id, b.title, b.status, b.created_at, p.name as publication_name
      FROM blogs b
      JOIN publications p ON b.publication_id = p.id
      WHERE p.user_id = $1
      ORDER BY b.created_at DESC
    `, [req.session.userId]);
    
    // Get blog count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM blogs b JOIN publications p ON b.publication_id = p.id WHERE p.user_id = $1',
      [req.session.userId]
    );
    
    res.render('dashboard', {
      user: { id: req.session.userId, username: req.session.username },
      publications: publicationsResult.rows,
      blogs: blogsResult.rows,
      blogCount: countResult.rows[0].count
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// New blog form
app.get('/blogs/new', isAuthenticated, async (req, res) => {
  try {
    const publicationsResult = await pool.query(
      'SELECT id, name FROM publications WHERE user_id = $1',
      [req.session.userId]
    );
    
    res.render('blog_form', {
      user: { id: req.session.userId, username: req.session.username },
      publications: publicationsResult.rows,
      blog: null,
      isEdit: false
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Create new blog
app.post('/blogs', isAuthenticated, upload.single('image'), async (req, res) => {
  const { title, summary, content, publication_id, status } = req.body;
  const image_ref = req.file ? req.file.path : null;
  
  try {
    // First verify the publication belongs to this user
    const pubCheck = await pool.query(
      'SELECT id FROM publications WHERE id = $1 AND user_id = $2',
      [publication_id, req.session.userId]
    );
    
    if (pubCheck.rows.length === 0) {
      return res.status(403).send('Unauthorized');
    }
    
    // Create a slug from the title
    const slug = title.toLowerCase().replace(/[^\w\s]/gi, '').replace(/\s+/g, '-');
    
    // Begin transaction
    await pool.query('BEGIN');
    
    // Insert blog
    const blogResult = await pool.query(
      `INSERT INTO blogs 
       (publication_id, title, slug, summary, content, status, view_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, NOW(), NOW())
       RETURNING id`,
      [publication_id, title, slug, summary, content, status]
    );
    
    const blogId = blogResult.rows[0].id;
    
    // If image was uploaded, save it
    if (image_ref) {
      await pool.query(
        'INSERT INTO images (blog_id, image_ref, alt_text, created_at) VALUES ($1, $2, $3, NOW())',
        [blogId, image_ref, title]
      );
    }
    
    // Commit transaction
    await pool.query('COMMIT');
    
    res.redirect('/dashboard');
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Server error');
  }
});

// View blog
app.get('/blogs/:id', async (req, res) => {
  try {
    // Increment view count
    await pool.query('UPDATE blogs SET view_count = view_count + 1 WHERE id = $1', [req.params.id]);
    
    // Get blog with author info
    const blogResult = await pool.query(`
      SELECT b.id, b.title, b.summary, b.content, b.created_at, b.view_count,
             u.username, p.name as publication_name
      FROM blogs b
      JOIN publications p ON b.publication_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE b.id = $1 AND b.status = 'published'
    `, [req.params.id]);
    
    if (blogResult.rows.length === 0) {
      return res.status(404).send('Blog not found');
    }
    
    // Get blog images
    const imagesResult = await pool.query(
      'SELECT image_ref, alt_text FROM images WHERE blog_id = $1',
      [req.params.id]
    );
    
    res.render('blog', {
      user: req.session.userId ? { id: req.session.userId, username: req.session.username } : null,
      blog: blogResult.rows[0],
      images: imagesResult.rows,
      isOwner: req.session.userId && blogResult.rows[0].user_id === req.session.userId
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Edit blog form
app.get('/blogs/:id/edit', isAuthenticated, async (req, res) => {
  try {
    // Get blog with security check
    const blogResult = await pool.query(`
      SELECT b.id, b.title, b.summary, b.content, b.publication_id, b.status
      FROM blogs b
      JOIN publications p ON b.publication_id = p.id
      WHERE b.id = $1 AND p.user_id = $2
    `, [req.params.id, req.session.userId]);
    
    if (blogResult.rows.length === 0) {
      return res.status(403).send('Unauthorized');
    }
    
    // Get user's publications
    const publicationsResult = await pool.query(
      'SELECT id, name FROM publications WHERE user_id = $1',
      [req.session.userId]
    );
    
    res.render('blog_form', {
      user: { id: req.session.userId, username: req.session.username },
      publications: publicationsResult.rows,
      blog: blogResult.rows[0],
      isEdit: true
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Update blog
app.post('/blogs/:id', isAuthenticated, upload.single('image'), async (req, res) => {
  const { title, summary, content, publication_id, status } = req.body;
  const image_ref = req.file ? req.file.path : null;
  
  try {
    // First verify the blog belongs to this user
    const blogCheck = await pool.query(`
      SELECT b.id 
      FROM blogs b
      JOIN publications p ON b.publication_id = p.id
      WHERE b.id = $1 AND p.user_id = $2
    `, [req.params.id, req.session.userId]);
    
    if (blogCheck.rows.length === 0) {
      return res.status(403).send('Unauthorized');
    }
    
    // Begin transaction
    await pool.query('BEGIN');
    
    // Update blog
    await pool.query(
      `UPDATE blogs 
       SET title = $1, summary = $2, content = $3, publication_id = $4, status = $5, updated_at = NOW()
       WHERE id = $6`,
      [title, summary, content, publication_id, status, req.params.id]
    );
    
    // If new image was uploaded, save it
    if (image_ref) {
      await pool.query(
        'INSERT INTO images (blog_id, image_ref, alt_text, created_at) VALUES ($1, $2, $3, NOW())',
        [req.params.id, image_ref, title]
      );
    }
    
    // Commit transaction
    await pool.query('COMMIT');
    
    res.redirect('/dashboard');
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Delete blog
app.post('/blogs/:id/delete', isAuthenticated, async (req, res) => {
  try {
    // First verify the blog belongs to this user
    const blogCheck = await pool.query(`
      SELECT b.id 
      FROM blogs b
      JOIN publications p ON b.publication_id = p.id
      WHERE b.id = $1 AND p.user_id = $2
    `, [req.params.id, req.session.userId]);
    
    if (blogCheck.rows.length === 0) {
      return res.status(403).send('Unauthorized');
    }
    
    // Begin transaction
    await pool.query('BEGIN');
    
    // Delete images
    await pool.query('DELETE FROM images WHERE blog_id = $1', [req.params.id]);
    
    // Delete blog
    await pool.query('DELETE FROM blogs WHERE id = $1', [req.params.id]);
    
    // Commit transaction
    await pool.query('COMMIT');
    
    res.redirect('/dashboard');
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error(err);
    res.status(500).send('Server error');
  }
});

// User profile
app.get('/users/:username', async (req, res) => {
  try {
    // Get user info
    const userResult = await pool.query(
      'SELECT id, username FROM users WHERE username = $1',
      [req.params.username]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).send('User not found');
    }
    
    const userId = userResult.rows[0].id;
    
    // Get publications
    const publicationsResult = await pool.query(
      'SELECT id, name, description FROM publications WHERE user_id = $1',
      [userId]
    );
    
    // Get published blogs
    const blogsResult = await pool.query(`
      SELECT b.id, b.title, b.summary, b.created_at, p.name as publication_name
      FROM blogs b
      JOIN publications p ON b.publication_id = p.id
      WHERE p.user_id = $1 AND b.status = 'published'
      ORDER BY b.created_at DESC
    `, [userId]);
    
    // Get blog count
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM blogs b JOIN publications p ON b.publication_id = p.id WHERE p.user_id = $1 AND b.status = \'published\'',
      [userId]
    );
    
    res.render('profile', {
      user: req.session.userId ? { id: req.session.userId, username: req.session.username } : null,
      profile: userResult.rows[0],
      publications: publicationsResult.rows,
      blogs: blogsResult.rows,
      blogCount: countResult.rows[0].count,
      isOwner: req.session.userId === userId
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Search
app.get('/search', async (req, res) => {
  const query = req.query.q || '';
  
  if (!query.trim()) {
    return res.redirect('/');
  }
  
  try {
    const result = await pool.query(`
      SELECT b.id, b.title, b.summary, b.created_at, u.username, p.name as publication_name
      FROM blogs b
      JOIN publications p ON b.publication_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE b.status = 'published' AND 
            (b.title ILIKE $1 OR b.summary ILIKE $1 OR b.content ILIKE $1 OR
             p.name ILIKE $1 OR u.username ILIKE $1)
      ORDER BY b.created_at DESC
      LIMIT 20
    `, [`%${query}%`]);
    
    res.render('search_results', {
      user: req.session.userId ? { id: req.session.userId, username: req.session.username } : null,
      query: query,
      results: result.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// DB Initialization script
const initDb = async () => {
  try {
    // Check if tables exist
    const tableCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'users'
    `);
    
    if (tableCheck.rows.length > 0) {
      console.log('Database already initialized');
      return;
    }
    
    console.log('Initializing database...');
    
    // Create users table
    await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(100) NOT NULL,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL
      )
    `);
    
    // Create publications table
    await pool.query(`
      CREATE TABLE publications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL
      )
    `);
    
    // Create blogs table
    await pool.query(`
      CREATE TABLE blogs (
        id SERIAL PRIMARY KEY,
        publication_id INTEGER REFERENCES publications(id) ON DELETE CASCADE,
        title VARCHAR(200) NOT NULL,
        slug VARCHAR(200) NOT NULL,
        summary TEXT,
        content TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'draft',
        view_count INTEGER DEFAULT 0,
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL
      )
    `);
    
    // Create images table
    await pool.query(`
      CREATE TABLE images (
        id SERIAL PRIMARY KEY,
        blog_id INTEGER REFERENCES blogs(id) ON DELETE CASCADE,
        image_ref VARCHAR(200) NOT NULL,
        alt_text VARCHAR(200),
        created_at TIMESTAMP NOT NULL
      )
    `);
    
    // Create tags table
    await pool.query(`
      CREATE TABLE tags (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        created_at TIMESTAMP NOT NULL
      )
    `);
    
    // Create blog_tags join table
    await pool.query(`
      CREATE TABLE blog_tags (
        blog_id INTEGER REFERENCES blogs(id) ON DELETE CASCADE,
        tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (blog_id, tag_id)
      )
    `);
    
    // Create indexes
    await pool.query('CREATE INDEX idx_blogs_publication_id ON blogs(publication_id)');
    await pool.query('CREATE INDEX idx_blogs_status ON blogs(status)');
    await pool.query('CREATE INDEX idx_images_blog_id ON images(blog_id)');
    await pool.query('CREATE INDEX idx_publications_user_id ON publications(user_id)');
    
    console.log('Database initialized successfully');
    
    // Insert sample data
    await pool.query(`
      INSERT INTO users (username, email, password_hash, created_at, updated_at)
      VALUES ('admin', 'admin@example.com', 'admin123', NOW(), NOW())
    `);
    
    const userResult = await pool.query('SELECT id FROM users WHERE username = \'admin\'');
    const userId = userResult.rows[0].id;
    
    await pool.query(`
      INSERT INTO publications (user_id, name, description, created_at, updated_at)
      VALUES ($1, 'Admin Blog', 'The official blog', NOW(), NOW())
    `, [userId]);
    
    const pubResult = await pool.query('SELECT id FROM publications WHERE user_id = $1', [userId]);
    const pubId = pubResult.rows[0].id;
    
    await pool.query(`
      INSERT INTO blogs (publication_id, title, slug, summary, content, status, created_at, updated_at)
      VALUES ($1, 'Welcome to the Blog Platform', 'welcome-to-the-blog-platform', 
              'A brief introduction to our new platform.', 
              'This is a sample blog post. Here you can write about anything you want. Use the editor to format your text, add images, and more.', 
              'published', NOW(), NOW())
    `, [pubId]);
    
    console.log('Sample data created');
    
  } catch (err) {
    console.error('Database initialization error:', err);
  }
};

// Initialize the database and start the server
initDb().then(() => {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
});
