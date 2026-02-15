# Lensy POS - Optical Shop Point of Sale System

A comprehensive Point of Sale (POS) system designed specifically for optical shops, built with **Flet** (Flutter for Python) for a modern, cross-platform UI experience.

![Python](https://img.shields.io/badge/Python-3.10+-blue.svg)
![Flet](https://img.shields.io/badge/Flet-0.27+-green.svg)
![License](https://img.shields.io/badge/License-MIT-yellow.svg)

## ✨ Features

### 🛒 Point of Sale (POS)
- **Multi-step ordering flow**: Category → Customer → Examination → Items → Payment
- **5 Product Categories**: Glasses, Sunglasses, Contact Lenses, Accessories, Others
- **Customer Management**: Quick search, create, and select customers
- **Optical Examinations**: 
  - Multiple examination rows per order
  - Distance, Reading, and Contact Lens prescriptions
  - Past examinations history and reuse
  - Automatic lens/frame type management
- **Smart Cart**: 
  - Frame auto-add from examination
  - Quick product search by SKU/name
  - Quantity adjustment (+/-)
  - Real-time totals calculation
- **Payment Tracking**: Discount, amount paid, and balance calculation
- **Receipt Preview**: Generate and print receipts

### 📦 Inventory Management
- Product catalog with categories (Frame, Sunglasses, Accessory, Contact Lens, Other)
- **Stock Movements**: Calculated from movement records (sale, purchase, adjustment)
- Stock adjustment dialog with movement history
- Optical settings management (lens types, frame types, colors)
- Supplier management

### 👥 Customer CRM
- Customer database with full contact details
- Order history per customer
- Total spent and balance tracking
- Prescription and examination history

### 🔬 Lab Management
- Track order status: Not Started → In Lab → Ready → Received
- Status summary badges
- Lab copy printing for technicians
- Examination details view

### 📊 Reports & Analytics
- Revenue summary (total, today, this month)
- Payment tracking and balance due
- Low stock alerts
- Top customers ranking
- Order statistics

### 📜 Sales History
- Search by invoice, customer, or doctor
- Filter by status and payment status
- Record additional payments
- View invoice details
- Print receipts

### 👤 Staff Management
- User creation and management
- Password change functionality
- Role assignment (Admin, Seller)
- User activation/deactivation

### ⚙️ Settings
- Shop information (name, address, phone)
- Currency configuration
- Optical metadata management
- Data backup and reset

### 🔍 Global Search
- Quick search across customers, products, and invoices
- Available from dashboard

## 🛠️ Technology Stack

- **Frontend**: [Flet](https://flet.dev/) - Python-based Flutter framework
- **Data Storage**: 
  - Local: JSON file (`pos_data.json`)
  - Cloud: [Supabase](https://supabase.com/) (optional)
- **Web Bridge**: Flask (for remote/mobile access)
- **Authentication**: bcrypt + passlib

## 📦 Installation

### Prerequisites
- Python 3.10+
- pip (Python package manager)

### Quick Start

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd optical-pos
   ```

2. **Create virtual environment**:
   ```bash
   python -m venv .venv
   
   # Windows
   .\.venv\Scripts\activate
   
   # Linux/Mac
   source .venv/bin/activate
   ```

3. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Run the application**:
   ```bash
   python main.py
   ```

## 🚀 Running the Application

### Desktop Mode (Flet)
```bash
python main.py
```

### Web Mode (Flask Bridge for Mobile/Remote Access)
```bash
python run_web.py
```
Access at `http://localhost:5000`

### Remote Access with Ngrok
For permanent free remote access:
```bash
ngrok http --domain=your-subdomain.ngrok-free.dev 5000
```

## 🔐 Default Credentials
- **Username**: `admin`
- **Password**: `Admin123`

## 📁 Project Structure

```
optical-pos/
├── main.py                 # Flet app entry point
├── run_web.py              # Flask web bridge
├── web_app.py              # Flask routes
├── requirements.txt        # Python dependencies
├── pos_data.json           # Local JSON database
├── app/
│   ├── config.py           # App configuration
│   ├── core/
│   │   ├── auth.py         # Authentication
│   │   ├── i18n.py         # Internationalization
│   │   └── state.py        # Application state
│   ├── database/
│   │   └── repository.py   # Data access layer
│   └── ui/
│       └── flet_pages/     # Flet UI views
│           ├── dashboard.py
│           ├── pos.py      # Main POS view
│           ├── inventory.py
│           ├── customers.py
│           ├── prescriptions.py
│           ├── history.py
│           ├── lab.py
│           ├── reports.py
│           ├── staff.py
│           ├── settings.py
│           └── login.py
├── static/                 # Static files for PWA
├── templates/              # Flask templates
└── uploads/                # Uploaded files
```

## 💾 Stock Movement Logic

Stock is calculated dynamically from movement records:
```
Current Stock = SUM(stock_movements.qty WHERE product_id = ?)
```

Movement types:
- `initial` - Initial stock setup
- `purchase` - Stock received from supplier
- `sale` - Stock sold to customer (negative qty)
- `adjustment` - Manual stock adjustment
- `return` - Stock returned to inventory

## ☁️ Cloud Deployment (Supabase)

1. Create a [Supabase](https://supabase.com/) project
2. Run the schema from `supabase_schema.sql`
3. Set environment variables:
   ```
   SUPABASE_URL=your_supabase_url
   SUPABASE_KEY=your_supabase_anon_key
   ```

## 📱 PWA Support

The Flask web bridge supports Progressive Web App (PWA) installation:
1. Access the web app on mobile
2. Click "Add to Home Screen"
3. Use as a native app

## 💾 Backup

For local JSON database:
- Copy `pos_data.json` to backup location regularly
- Use Settings → Backup tab to export data
- Store backups in cloud storage (OneDrive, Google Drive)

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Submit a pull request

## 📄 License

This project is licensed under the MIT License.

---

**Developed for Lensy Optical Shop** 🏪👓
