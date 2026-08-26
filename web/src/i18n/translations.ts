// Arabic translations, keyed by the English source string. `t('English')`
// returns the Arabic when lang==='ar', else the English key itself — so English
// needs no map and any missing Arabic falls back gracefully to English.
// Domain terms are reused from the Flet app (app/core/i18n.py) so the wording
// matches what the shop's staff already know.

export type Lang = 'ar' | 'en'

export const ar: Record<string, string> = {
  // Auth
  Welcome: 'مرحباً',
  Username: 'اسم المستخدم',
  Password: 'كلمة المرور',
  'Sign in': 'تسجيل الدخول',
  'Sign in to continue': 'سجّل الدخول للمتابعة',
  'Signing in…': 'جارٍ تسجيل الدخول…',
  'Sign out': 'تسجيل الخروج',
  'Enter username and password': 'أدخل اسم المستخدم وكلمة المرور',
  'Invalid login credentials': 'بيانات الدخول غير صحيحة',
  'Loading…': 'جارٍ التحميل…',

  // Nav
  Dashboard: 'الرئيسية',
  Sales: 'المبيعات',
  'New Sale': 'بيع جديد',
  Customers: 'العملاء',
  Inventory: 'المخزون',
  History: 'السجل',
  Reports: 'التقارير',
  Staff: 'الموظفون',
  Settings: 'الإعدادات',

  // Dashboard
  Overview: 'نظرة عامة',
  'Quick actions': 'إجراءات سريعة',
  Manage: 'إدارة',
  Stock: 'المخزون',
  Insights: 'إحصاءات',
  'POS wizard': 'معالج البيع',
  'Backend connectivity': 'الاتصال بقاعدة البيانات',

  // Common
  Save: 'حفظ',
  'Save Settings': 'حفظ الإعدادات',
  Cancel: 'إلغاء',
  Close: 'إغلاق',
  Edit: 'تعديل',
  Delete: 'حذف',
  Add: 'إضافة',
  Search: 'بحث',
  Print: 'طباعة',
  Done: 'تم',
  Remove: 'إزالة',
  Browse: 'تصفّح',
  'Use this': 'استخدم هذا',
  All: 'الكل',
  total: 'الإجمالي',
  Saved: 'تم الحفظ',
  Loading: 'جارٍ التحميل',
  'No matches.': 'لا توجد نتائج.',
  'Edit Customer': 'تعديل العميل',
  'Search by name, city, phone or doctor…': 'ابحث بالاسم أو المدينة أو الجوال أو الطبيب…',
  'Cannot delete this customer because they have existing orders or prescriptions.':
    'لا يمكن حذف هذا العميل لوجود طلبات أو وصفات مرتبطة به.',
  'Delete customer': 'حذف العميل',
  'This customer has': 'هذا العميل لديه',
  prescriptions: 'وصفات',
  and: 'و',
  'Deleting the customer will also permanently delete their orders and prescriptions. Continue?':
    'سيؤدي حذف العميل إلى حذف جميع طلباته ووصفاته نهائياً. هل تريد المتابعة؟',

  // Categories
  'Select Product Category': 'اختر فئة المنتج',
  Glasses: 'نظارات طبية',
  Sunglasses: 'نظارات شمسية',
  'Contact Lenses': 'عدسات لاصقة',
  Accessories: 'إكسسوارات',
  Others: 'أخرى',
  Frame: 'إطار',
  ContactLens: 'عدسات لاصقة',
  Accessory: 'إكسسوار',
  Lens: 'عدسة',
  Other: 'أخرى',

  // Stepper
  Category: 'الفئة',
  Customer: 'العميل',
  Exam: 'الفحص',
  Items: 'الأصناف',
  Order: 'الطلب',
  Payment: 'الدفع',

  // Customer step
  'Step 1: Customer Selection': 'الخطوة 1: اختيار العميل',
  'Enter customer info or pick a match below.': 'أدخل بيانات العميل أو اختر من النتائج أدناه.',
  Name: 'الاسم',
  'Name *': 'الاسم *',
  'Mobile Phone': 'رقم الجوال',
  City: 'المدينة',
  Email: 'البريد الإلكتروني',
  Address: 'العنوان',
  Phone: 'الهاتف',
  'Matching customers': 'العملاء المطابقون',
  'Start typing a name to search…': 'ابدأ بكتابة الاسم للبحث…',
  'Searching…': 'جارٍ البحث…',
  'No match — a new customer will be created when you continue.':
    'لا يوجد تطابق — سيتم إنشاء عميل جديد عند المتابعة.',
  'Please enter customer name.': 'يرجى إدخال اسم العميل.',
  'Could not save customer': 'تعذّر حفظ العميل',
  'Walk-in': 'عميل عابر',
  'Saving…': 'جارٍ الحفظ…',
  'Continue with Customer →': 'استمر مع العميل ←',
  '← Back': '← رجوع',

  // Examination
  'Step 2: Order & Examination': 'الخطوة 2: الطلب والفحص',
  'Walk-in Customer': 'عميل عابر',
  'Delivery Date': 'تاريخ التسليم',
  'Doctor Name': 'اسم الطبيب',
  'Exam Type': 'نوع الفحص',
  Distance: 'بُعد',
  Reading: 'قراءة',
  'Lens Type': 'نوع العدسة',
  Color: 'اللون',
  Status: 'الحالة',
  New: 'جديد',
  Old: 'عميل',
  IPD: 'المسافة بين الحدقتين',
  '+ Add Another Exam': '+ إضافة فحص آخر',
  'Add More Items': 'إضافة المزيد من الأصناف',
  'Next: Payment →': 'التالي: الدفع ←',
  'Working…': 'جارٍ العمل…',
  'Could not prepare order': 'تعذّر تجهيز الطلب',
  'Previous Prescriptions': 'الوصفات السابقة',
  'Order Date': 'تاريخ الطلب',
  'This frame quantity is 0 or below — you can still sell it.':
    'كمية هذا الإطار صفر أو أقل — لا يزال بإمكانك بيعها.',
  'Frame not found in inventory — it will be recorded with 0 quantity.':
    'الإطار غير موجود في المخزون — سيتم تسجيله بكمية صفر.',

  // Additional items
  'Step 3: Add More Items': 'الخطوة 3: إضافة المزيد من الأصناف',
  'Add accessories or other products to this order.': 'أضف إكسسوارات أو منتجات أخرى لهذا الطلب.',
  'All Categories': 'كل الفئات',
  'Search products…': 'البحث عن منتجات…',
  'No products.': 'لا توجد منتجات.',
  'Add +1': 'إضافة +1',
  '← Back to Order': '← العودة للطلب',

  // Cart & payment
  'Step 3: Order & Payment': 'الخطوة 3: الطلب والدفع',
  'Step 3: Cart & Payment': 'الخطوة 3: السلة والدفع',
  'Cart & Payment': 'السلة والدفع',
  'Step 4: Cart & Payment': 'الخطوة 4: السلة والدفع',
  Invoice: 'فاتورة',
  'Quick add by SKU or name…': 'إضافة سريعة بالكود أو الاسم…',
  Product: 'المنتج',
  Qty: 'الكمية',
  Price: 'السعر',
  Total: 'الإجمالي',
  'Total Price': 'السعر الإجمالي',
  'Cart is empty.': 'السلة فارغة.',
  Pricing: 'التسعير',
  Discount: 'الخصم',
  'Amount Paid': 'المبلغ المدفوع',
  'Gross Total': 'الإجمالي الكلي',
  'Net Amount': 'المبلغ الصافي',
  'Remaining Balance': 'المبلغ المتبقي',
  'Clear Cart': 'مسح السلة',
  'Finish Checkout →': 'إنهاء الطلب ←',
  'Discard the current order and start a new sale?': 'إلغاء الطلب الحالي والبدء ببيع جديد؟',
  'Cart is empty and no examinations. Cannot checkout.':
    'السلة فارغة ولا توجد فحوصات. لا يمكن إتمام الطلب.',
  'Insufficient stock for:': 'مخزون غير كافٍ لـ:',
  'Error saving order': 'خطأ أثناء حفظ الطلب',

  // Receipt
  'Order Saved': 'تم حفظ الطلب',
  'Order Updated': 'تم تحديث الطلب',
  Shop: 'المحل',
  Lab: 'المعمل',
  'Print all 3': 'طباعة الثلاث نسخ',

  // Customers screen
  'No customers yet.': 'لا يوجد عملاء بعد.',
  'Search by name…': 'البحث بالاسم…',
  "Couldn't load customers:": 'تعذّر تحميل العملاء:',
  'Expected until you finish the Phase 2 Supabase setup (RLS + login).':
    'متوقع حتى إكمال إعداد Supabase (الصلاحيات + تسجيل الدخول).',

  // Inventory screen
  '+ New Product': '+ منتج جديد',
  'New Product': 'منتج جديد',
  'Edit Product': 'تعديل المنتج',
  'Search name, SKU, barcode…': 'بحث بالاسم أو الكود أو الباركود…',
  "Couldn't load inventory:": 'تعذّر تحميل المخزون:',
  SKU: 'كود المنتج',
  Barcode: 'الباركود',
  'Sale Price': 'سعر البيع',
  'Cost Price': 'سعر التكلفة',
  'Initial Stock': 'المخزون الأولي',
  'Name is required': 'الاسم مطلوب',
  'Save failed': 'فشل الحفظ',

  // History screen
  'Sales History': 'سجل المبيعات',
  orders: 'طلبات',
  'Search invoice # or customer…': 'بحث برقم الفاتورة أو العميل…',
  "Couldn't load sales:": 'تعذّر تحميل المبيعات:',
  'No line items.': 'لا توجد أصناف.',
  due: 'مستحق',
  Paid: 'مدفوع',
  Balance: 'المتبقي',
  'Not Started': 'لم يبدأ',
  'In Progress': 'قيد التنفيذ',
  Ready: 'جاهز',
  Delivered: 'تم التسليم',
  'Lab Status': 'حالة المعمل',
  'Edit Prescriptions': 'تعديل الوصفات',

  // Reports screen
  'Reports & Analytics': 'التقارير والتحليلات',
  Today: 'اليوم',
  'This Month': 'هذا الشهر',
  'All Time': 'كل الوقت',
  'Total Revenue': 'إجمالي الإيرادات',
  'Total Paid': 'إجمالي المدفوع',
  'Balance Due': 'الرصيد المستحق',
  'Total Orders': 'إجمالي الطلبات',
  "Today's Revenue": 'إيرادات اليوم',
  'Pending Lab': 'قيد المعمل',
  'Ready for Pickup': 'جاهز للاستلام',
  'Low Stock Alert': 'تنبيه نقص المخزون',
  'All products in stock.': 'جميع المنتجات متوفرة.',
  left: 'متبقٍ',
  'Top Customers': 'أفضل العملاء',
  'No customer data.': 'لا توجد بيانات عملاء.',

  // Staff screen
  'users': 'مستخدمون',
  'New staff logins are created in Supabase Auth (dashboard, or a service-role Edge Function) — see':
    'تُنشأ حسابات الموظفين في نظام مصادقة Supabase (لوحة التحكم) — راجع',
  'In-app staff creation lands in a later pass.':
    'سيُضاف إنشاء الموظفين داخل التطبيق لاحقاً.',
  "Couldn't load staff:": 'تعذّر تحميل الموظفين:',
  'Full Name': 'الاسم الكامل',
  Role: 'الدور',
  Active: 'نشط',
  Inactive: 'غير نشط',
  'No staff.': 'لا يوجد موظفون.',

  // Settings screen
  'Shop information shown on receipts.': 'معلومات المتجر التي تظهر على الإيصالات.',
  'Shop Name': 'اسم المتجر',
  Currency: 'العملة',

  // Offline
  'Offline — showing cached data. Changes will sync when you reconnect.':
    'غير متصل — يتم عرض بيانات مخزّنة. ستتم المزامنة عند عودة الاتصال.',

  // Optical settings
  'Optical Settings': 'إعدادات البصريات',
  'Lens types, frame types and colors used in prescriptions.':
    'أنواع العدسات والإطارات والألوان المستخدمة في الوصفات.',
  'Lens Types': 'أنواع العدسات',
  'Frame Types': 'أنواع الإطارات',
  'Frame Colors': 'ألوان الإطارات',

  // Lab
  'Lab Orders': 'طلبات المعمل',
  'No lab orders.': 'لا توجد طلبات مختبر.',
  'In Lab': 'في المعمل',
  Received: 'تم الاستلام',

  // Calculator + search
  Calculator: 'الآلة الحاسبة',
  'Quick search (customers, products, invoices)…': 'بحث سريع (عملاء، منتجات، فواتير)…',
  'No results.': 'لا توجد نتائج.',
  'Search Results': 'نتائج البحث',
  Products: 'المنتجات',
  Invoices: 'الفواتير',

  // Suppliers & shipments
  Suppliers: 'الموردون',
  '+ Add Supplier': '+ إضافة مورد',
  'No suppliers found': 'لا يوجد موردون',
  Shipments: 'الشحنات',
  'No shipments.': 'لا توجد شحنات.',
  'Select a supplier to view shipments.': 'اختر مورداً لعرض الشحنات.',
  Error: 'خطأ',
  Date: 'التاريخ',
  Payments: 'الدفعات',
  Remaining: 'المتبقي',
  'Add Payment': 'إضافة دفعة',
  'Down payment': 'دفعة أولى',
  'No payments yet.': 'لا توجد دفعات بعد.',
  'Record each payment inside the shipment below.':
    'سجّل كل دفعة داخل الشحنة أدناه.',
  'Delete supplier and all their shipments?': 'حذف المورد وجميع شحناته؟',
  'Payments ledger missing — run web/supabase/003_purchase_payments.sql in the Supabase SQL editor.':
    'جدول الدفعات غير موجود — نفّذ ملف web/supabase/003_purchase_payments.sql في محرر SQL بـ Supabase.',

  // Customer detail / prescriptions
  Orders: 'الطلبات',
  'No orders.': 'لا توجد طلبات.',
  Prescriptions: 'الوصفات الطبية',
  'No prescriptions.': 'لا توجد وصفات.',
  Prescription: 'وصفة',
  'View Image': 'عرض الصورة',

  // Language
  'العربية': 'العربية',
  English: 'English',
}
