# Lensy POS - Optical Shop Point of Sale System

A comprehensive Point of Sale (POS) system designed specifically for optical shops, built with **Flet** (Flutter for Python) for a modern, cross-platform UI experience.

![Python](https://img.shields.io/badge/Python-3.10+-blue.svg)
![Flet](https://img.shields.io/badge/Flet-0.28.3-green.svg)
![License](https://img.shields.io/badge/License-Commercial-yellow.svg)

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
├── supabase_full_schema.sql # Complete database schema (including licensing)
├── license_admin.py        # License management CLI tool
├── build_native_apps.py    # Native app builder script
├── app/
│   ├── config.py           # App configuration
│   ├── flet_compat.py      # Flet version compatibility
│   ├── core/
│   │   ├── auth.py         # Authentication
│   │   ├── i18n.py         # Internationalization
│   │   ├── licensing.py    # License management & auto-updates
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
│           ├── settings.py  # Includes License & Updates tab
│           ├── login.py
│           └── activation.py # License activation UI
├── static/                 # Static files for PWA
├── templates/              # Flask templates
└── uploads/                # Uploaded files
```

## 🔐 Software Licensing

The application includes a built-in licensing system for commercial distribution:

### Features
- **Machine-locked licenses**: Tied to specific hardware
- **License types**: Trial, Standard, Professional, Enterprise
- **Expiration support**: Time-limited or perpetual licenses
- **Offline grace period**: 7 days offline operation
- **License transfer**: Optional transferability between machines
- **Revocation**: Remote license invalidation

### Managing Licenses

Generate licenses using the admin CLI:
```bash
# Set Supabase credentials
$env:SUPABASE_URL = "your-supabase-url"
$env:SUPABASE_KEY = "your-supabase-key"

# Generate a license
python license_admin.py generate --name "Store Name" --email "email@example.com" --type standard --days 365

# List all licenses
python license_admin.py list

# Revoke a license
python license_admin.py revoke LICENSE-KEY
```

### Enabling Licensing
Set the environment variable:
```bash
ENABLE_LICENSING=true
```

## 🔄 Automatic Updates

The application supports automatic update checking:

1. **Check for updates**: Settings → License & Updates → Check for Updates
2. **View release notes**: See what's new in the latest version
3. **Download updates**: Direct download from configured URL
4. **Mandatory updates**: Force critical security updates

### Publishing Updates

Add new versions to the `app_updates` table in Supabase:
```sql
INSERT INTO app_updates (app_name, version, download_url, release_notes, is_mandatory, platform)
VALUES ('LensyPOS', '1.1.0', 'https://download.example.com/LensyPOS-1.1.0.exe', 'Bug fixes and improvements', FALSE, 'windows');
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
2. Run the schema from `supabase_full_schema.sql` in the SQL Editor
3. Set environment variables:
   ```bash
   SUPABASE_URL=your_supabase_url
   SUPABASE_KEY=your_supabase_anon_key
   ```

The schema includes:
- Users, roles, and permissions
- Customers, inventory, and products
- Sales and order management
- Prescriptions and examinations
- Licensing and app updates tables

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
