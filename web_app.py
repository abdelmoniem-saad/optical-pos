from flask import Flask, render_template, request, redirect, url_for, session, flash, send_from_directory
import datetime
import os
from app.database.db_manager import get_engine, get_session
from app.database.models import User, Product, Sale, Customer, StockMovement, OrderExamination, Prescription
from app.core.auth import authenticate_user
from app.core.permissions import has_permission
from sqlalchemy import func, not_
from functools import wraps

app = Flask(__name__)
# Use a fixed secret key if we want sessions to persist across restarts
# but for a simple bridge, urandom is fine.
app.secret_key = os.urandom(24)

# Database setup
engine = get_engine()

@app.route('/uploads/<path:filename>')
def uploaded_file(filename):
    return send_from_directory('uploads', filename)

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

def permission_required(permission_code):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if 'user_id' not in session:
                return redirect(url_for('login'))
            
            db_session = get_session(engine)
            try:
                allowed, value = has_permission(db_session, session['user_id'], permission_code)
                if not allowed:
                    flash(f"ليس لديك صلاحية: {permission_code}", "danger")
                    return redirect(url_for('dashboard'))
            finally:
                db_session.close()
            return f(*args, **kwargs)
        return decorated_function
    return decorator

@app.context_processor
def inject_now():
    def check_perm(p):
        if not session.get('user_id'): return False
        db_session = get_session(engine)
        try:
            from app.core.permissions import has_permission
            allowed, _ = has_permission(db_session, session.get('user_id'), p)
            return allowed
        finally:
            db_session.close()
            
    return {
        'now': datetime.datetime.utcnow(),
        'has_perm': check_perm
    }

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        
        db_session = get_session(engine)
        try:
            user = authenticate_user(db_session, username, password)
            if user:
                session['user_id'] = user.id
                session['username'] = user.username
                session['full_name'] = user.full_name
                return redirect(url_for('dashboard'))
            else:
                flash('اسم المستخدم أو كلمة المرور غير صحيحة', 'danger')
        finally:
            db_session.close()
            
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@app.route('/')
@login_required
def dashboard():
    db_session = get_session(engine)
    try:
        today = datetime.datetime.utcnow().date()
        start_of_today = datetime.datetime.combine(today, datetime.time.min)
        
        # Check if user can view reports
        can_view_reports, _ = has_permission(db_session, session['user_id'], "REPORT_DAILY_SALES")
        
        if not can_view_reports:
            return render_template('dashboard.html', 
                                   revenue=0, 
                                   paid=0, 
                                   count=0,
                                   low_stock=0,
                                   no_permission=True)

        # Today's Sales Stats
        sales_today = db_session.query(Sale).filter(Sale.order_date >= start_of_today).all()
        total_revenue = sum(s.net_amount for s in sales_today)
        total_paid = sum(s.amount_paid for s in sales_today)
        sales_count = len(sales_today)
        
        return render_template('dashboard.html', 
                               revenue=total_revenue, 
                               paid=total_paid, 
                               count=sales_count,
                               low_stock=0)
    finally:
        db_session.close()

@app.route('/inventory')
@login_required
@permission_required('VIEW_PRODUCTS')
def inventory():
    db_session = get_session(engine)
    try:
        q = request.args.get('q', '')
        query = db_session.query(Product)
        
        # Exclude Lens and ContactLens from inventory list
        query = query.filter(not_(Product.category.in_(['Lens', 'ContactLens'])))

        if q:
            query = query.filter(
                (Product.name.ilike(f"%{q}%")) | 
                (Product.sku.ilike(f"%{q}%")) | 
                (Product.barcode.ilike(f"%{q}%")) |
                (Product.lens_type.ilike(f"%{q}%")) |
                (Product.frame_type.ilike(f"%{q}%")) |
                (Product.frame_color.ilike(f"%{q}%"))
            )
        
        products = query.all()
        inventory_data = []
        for p in products:
            stock = db_session.query(func.sum(StockMovement.qty)).filter_by(product_id=p.id).scalar() or 0
            inventory_data.append({
                'sku': p.sku,
                'name': p.name,
                'sale_price': p.sale_price,
                'stock': stock,
                'category': p.category,
                'lens_type': p.lens_type,
                'frame_type': p.frame_type,
                'frame_color': p.frame_color,
                'barcode': p.barcode
            })
        return render_template('inventory.html', products=inventory_data, query=q)
    finally:
        db_session.close()

@app.route('/lab')
@login_required
@permission_required('VIEW_LAB')
def lab():
    db_session = get_session(engine)
    try:
        q = request.args.get('q', '')
        status_filter = request.args.get('status', '')
        
        query = db_session.query(Sale).join(Customer, isouter=True)
        if q:
            query = query.filter(
                (Sale.invoice_no.ilike(f"%{q}%")) |
                (Customer.name.ilike(f"%{q}%"))
            )
        if status_filter:
            query = query.filter(Sale.lab_status == status_filter)
        
        orders = query.order_by(Sale.order_date.desc()).limit(50).all()
        
        # Check edit permission
        can_edit_lab, _ = has_permission(db_session, session['user_id'], "EDIT_LAB")
        
        return render_template('lab.html', orders=orders, query=q, status_filter=status_filter, can_edit=can_edit_lab)
    finally:
        db_session.close()

@app.route('/api/update_lab_status', methods=['POST'])
@login_required
@permission_required('EDIT_LAB')
def update_lab_status():
    sale_id = request.form.get('sale_id')
    new_status = request.form.get('status')
    
    db_session = get_session(engine)
    try:
        sale = db_session.query(Sale).get(sale_id)
        if sale:
            sale.lab_status = new_status
            if new_status == 'Received':
                sale.is_received = True
                sale.receiving_date = datetime.datetime.utcnow()
            db_session.commit()
            flash(f"تم تحديث حالة الفاتورة {sale.invoice_no}", "success")
        else:
            flash("الفاتورة غير موجودة", "danger")
    except Exception as e:
        db_session.rollback()
        flash(f"خطأ: {str(e)}", "danger")
    finally:
        db_session.close()
    
    return redirect(request.referrer or url_for('lab'))

@app.route('/customer/<int:customer_id>')
@login_required
@permission_required('VIEW_PRESCRIPTIONS')
def customer_detail(customer_id):
    db_session = get_session(engine)
    try:
        customer = db_session.query(Customer).get(customer_id)
        if not customer:
            flash("العميل غير موجود", "danger")
            return redirect(url_for('customers'))
        
        # Manual Prescriptions
        rxs = db_session.query(Prescription).filter_by(customer_id=customer_id).order_by(Prescription.created_at.desc()).all()
        
        # POS Exams
        sales = db_session.query(Sale).filter_by(customer_id=customer_id).order_by(Sale.order_date.desc()).all()
        
        return render_template('customer_detail.html', customer=customer, prescriptions=rxs, sales=sales)
    finally:
        db_session.close()

@app.route('/customers')
@login_required
@permission_required('VIEW_CUSTOMERS')
def customers():
    db_session = get_session(engine)
    try:
        q = request.args.get('q', '')
        query = db_session.query(Customer)
        if q:
            query = query.filter((Customer.name.ilike(f"%{q}%")) | (Customer.phone.ilike(f"%{q}%")))
        
        customers_list = query.order_by(Customer.name).all()
        return render_template('customers.html', customers=customers_list, query=q)
    finally:
        db_session.close()

@app.route('/sales')
@login_required
@permission_required('REPORT_DAILY_SALES')
def sales():
    db_session = get_session(engine)
    try:
        q = request.args.get('q', '')
        if q:
            sales = db_session.query(Sale).join(Customer, isouter=True).filter(
                (Sale.invoice_no.ilike(f"%{q}%")) |
                (Customer.name.ilike(f"%{q}%")) |
                (Customer.phone.ilike(f"%{q}%"))
            ).order_by(Sale.order_date.desc()).limit(50).all()
        else:
            today = datetime.datetime.utcnow().date()
            start_of_today = datetime.datetime.combine(today, datetime.time.min)
            sales = db_session.query(Sale).join(Customer, isouter=True).filter(Sale.order_date >= start_of_today).order_by(Sale.order_date.desc()).all()
        
        return render_template('sales.html', sales=sales, query=q)
    finally:
        db_session.close()

# PWA Routes
@app.route('/manifest.json')
def manifest():
    return app.send_static_file('manifest.json')

@app.route('/sw.js')
def service_worker():
    return app.send_static_file('sw.js')

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)
