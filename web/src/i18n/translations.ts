// Arabic translations, keyed by the English source string. `t('English')`
// returns the Arabic when lang==='ar', else the English key itself - so English
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
  'Continue': 'متابعة',
  'No access group (full access)': 'بدون مجموعة صلاحيات (وصول كامل)',
  'No staff record is linked to this account, so access control is not applied.':
    'لا يوجد سجل موظف مرتبط بهذا الحساب، لذلك لا يتم تطبيق صلاحيات الوصول.',
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
  'No match - a new customer will be created when you continue.':
    'لا يوجد تطابق - سيتم إنشاء عميل جديد عند المتابعة.',
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
  'This frame quantity is 0 or below - you can still sell it.':
    'كمية هذا الإطار صفر أو أقل - لا يزال بإمكانك بيعها.',
  'Frame not found in inventory - it will be recorded with 0 quantity.':
    'الإطار غير موجود في المخزون - سيتم تسجيله بكمية صفر.',

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
  Cash: 'كاش',
  Wallet: 'محفظة',
  InstaPay: 'انستاباي',
  'Payment recorded.': 'تم تسجيل الدفعة.',
  Card: 'بطاقة',
  'First customer of the day': 'أول عميل في اليوم',
  'Last customer of the day': 'آخر عميل في اليوم',
  'Next customer': 'العميل التالي',
  'Previous customer': 'العميل السابق',
  'Discard the current order and open another invoice?':
    'تجاهل الطلب الحالي وفتح فاتورة أخرى؟',
  'Record payments with the Add Payment button.':
    'سجّل الدفعات عبر زر إضافة دفعة.',
  'Payment ledger missing - run web/supabase/011_sale_payments.sql in the Supabase SQL editor.':
    'سجل الدفعات غير موجود - نفّذ ملف web/supabase/011_sale_payments.sql في محرر SQL بـ Supabase.',
  'By payment method': 'حسب طريقة الدفع',
  'No payments in this period.': 'لا توجد دفعات في هذه الفترة.',
  // Phase 4 — a void is excluded from revenue but must stay visible
  'Excluded from these totals': 'مستثناة من هذه الإجماليات',
  'voided invoice': 'فاتورة ملغاة',
  // Migration 013 — voiding
  'Void': 'إلغاء',
  'Voided': 'ملغاة',
  'Void invoice': 'إلغاء الفاتورة',
  'Invoice voided.': 'تم إلغاء الفاتورة.',
  'Void this invoice? The stock goes back and the money is refunded. Nothing is deleted.':
    'إلغاء هذه الفاتورة؟ سيعود المخزون وتُسترد المبالغ. لن يتم حذف أي شيء.',
  'Why is this invoice being voided?': 'لماذا يتم إلغاء هذه الفاتورة؟',
  'wrong customer, cancelled order…': 'عميل خاطئ، طلب ملغى…',
  'Put the items back into stock': 'إعادة الأصناف إلى المخزون',
  'The goods left the shop, so stock stays down.': 'البضاعة غادرت المحل، لذلك يبقى المخزون كما هو.',
  // Migration 014 - an account with no store row
  'This account is not linked to a store': 'هذا الحساب غير مرتبط بأي محل',
  'Your sign-in worked, but no staff record points it at a shop, so there is nothing to show. Ask whoever administers this store to add your account.':
    'تم تسجيل دخولك، لكن لا يوجد سجل موظف يشير إلى هذا المحل، لذلك لا يوجد ما يُعرض. اطلب من المسؤول عن هذا المحل إضافة حسابك.',
  'Signed in as': 'تم تسجيل الدخول باسم',
  'Refund': 'استرداد',
  // Migration 013 - line-level discount
  'Line discount': 'خصم على الصنف',
  'Reason': 'السبب',
  'loyal customer, agreed price…': 'عميل قديم، سعر متفق عليه...',
  'Gross Total': 'الإجمالي الكلي',
  'Net Amount': 'المبلغ الصافي',
  'Remaining Balance': 'المبلغ المتبقي',
  'Clear Cart': 'مسح السلة',
  'Finish Checkout →': 'إنهاء الطلب ←',
  'Discard the current order and start a new sale?': 'إلغاء الطلب الحالي والبدء ببيع جديد؟',
  'Cart is empty and no examinations. Cannot checkout.':
    'السلة فارغة ولا توجد فحوصات. لا يمكن إتمام الطلب.',
  'Insufficient stock for:': 'مخزون غير كافٍ لـ:',
  'Price changed for:': 'تغيّر السعر أثناء المراجعة لـ:',
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
  'New staff logins are created in Supabase Auth (dashboard, or a service-role Edge Function) - see':
    'تُنشأ حسابات الموظفين في نظام مصادقة Supabase (لوحة التحكم) - راجع',
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

  // Offline. The wording states what actually happens to a WRITE made while
  // offline, because the previous version promised a sync that did not exist.
  'Offline - showing cached data. Changes will sync when you reconnect.':
    'غير متصل - يتم عرض بيانات مخزّنة. ستتم المزامنة عند عودة الاتصال.',
  'Offline - showing saved data. New sales cannot be saved until you reconnect.':
    'غير متصل - يتم عرض بيانات محفوظة. لا يمكن حفظ عمليات بيع جديدة حتى يعود الاتصال.',
  'Saved on this device. It will sync to the shop when you reconnect.':
    'محفوظ على هذا الجهاز. سيتم مزامنته مع المحل عند عودة الاتصال.',

  // Purchasing and receiving (migration 018)
  'Not received': 'لم يتم الاستلام',
  'Receive into stock': 'استلام إلى المخزون',
  'Receiving…': 'جارٍ الاستلام…',
  '+ Add Shipment': '+ إضافة شحنة',
  '+ Add item': '+ إضافة صنف',
  'Choose a product…': 'اختر منتجاً…',
  Cost: 'التكلفة',
  'Save and receive': 'حفظ واستلام',
  'List what arrived so the stock can be counted in. The total is worked out for you.':
    'سجّل ما وصل ليتم احتسابه في المخزون. يتم حساب الإجمالي تلقائياً.',
  'Receiving stock needs migration 018_purchase_stock.sql.':
    'استلام المخزون يتطلب الترحيل 018_purchase_stock.sql.',

  // Customer balances (migration 018)
  Owes: 'المستحق عليه',
  'Total purchases': 'إجمالي المشتريات',
  'Nobody owes money.': 'لا يوجد مستحقات على أي عميل.',
  'customer owes money': 'عميل عليهم مستحقات',
  'Balances need migration 018_purchase_stock.sql.':
    'الأرصدة تتطلب الترحيل 018_purchase_stock.sql.',

  // Lab dwell times (migration 019)
  Waiting: 'مدة الانتظار',
  'Lab timings need migration 019_lab_dwell.sql.':
    'مدد المختبر تتطلب الترحيل 019_lab_dwell.sql.',

  // Schema drift (migration 017). Says what to DO, not just what is wrong -
  // the person reading this is staff, not whoever deployed the update.
  'This app needs a database update. Ask your administrator to run the latest migration file.':
    'هذا التطبيق يحتاج تحديث قاعدة البيانات. اطلب من المسؤول تشغيل ملف الترحيل الأحدث.',
  Expected: 'المطلوب',
  installed: 'المُثبَّت',

  // Optical settings
  'Optical Settings': 'إعدادات البصريات',
  'Lens types and colors used in prescriptions.':
    'أنواع العدسات والألوان المستخدمة في الوصفات.',
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
  'Payments ledger missing - run web/supabase/003_purchase_payments.sql in the Supabase SQL editor.':
    'جدول الدفعات غير موجود - نفّذ ملف web/supabase/003_purchase_payments.sql في محرر SQL بـ Supabase.',

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

  // Notes tab
  Notes: 'الملاحظات',
  'My Notes': 'ملاحظاتي',
  Everyone: 'الجميع',
  'Write a note…': 'اكتب ملاحظة…',
  'No notes yet.': 'لا توجد ملاحظات بعد.',

  // Staff access control
  'Access Control': 'التحكم في الصلاحيات',
  Employees: 'الموظفون',
  Position: 'المنصب',
  '+ Add Position': '+ إضافة منصب',
  Employee: 'الموظف',
  Inherit: 'حسب الدور',
  Allowed: 'مسموح',
  Denied: 'ممنوع',
  view: 'عرض',
  create: 'إضافة',
  edit: 'تعديل',
  delete: 'حذف',
  'You do not have access to this page.': 'ليست لديك صلاحية للوصول إلى هذه الصفحة.',
  'Load more': 'تحميل المزيد',
  edited: 'معدلة',
  'Mark as seen': 'تأكيد الاطلاع',
  Seen: 'تم الاطلاع',
  'Seen by': 'اطلعوا عليه',
  'Owner/admin positions always have full access.':
    'مناصب المالك/المدير تتمتع دائماً بكامل الصلاحيات.',
  'This person is an owner/admin, they always have full access, so there is nothing to configure.':
    'هذا الشخص مالك/مدير, تتمتع دائماً بكامل الصلاحيات، ولا يوجد ما يمكن ضبطه.',
  'Defaults for everyone in this position.': 'الإعدادات الافتراضية لكل من يحمل هذا المنصب.',
  'Exceptions for this person, click to cycle: follow position → allowed (✓) → blocked (✕).':
    'استثناءات لهذا الشخص, اضغط للتبديل: يتبع المنصب ← مسموح (✓) ← ممنوع (✕).',
  'Follows position': 'يتبع المنصب',
  'You are changing your own access, be careful!': 'أنت تعدّل صلاحياتك أنت, انتبه!',
  'This may lock you out of the Staff page. Continue?':
    'قد يؤدي هذا إلى منعك من الوصول لصفحة الموظفين. متابعة؟',
  'Order images': 'صور الطلب',
  'Rx paper photo': 'صورة الروشتة',
  'Frame photo': 'صورة الفريم',
  'Attach from mobile': 'إرفاق من الجوال',
  'Mobile upload': 'رفع من الجوال',
  'Replace requires admin': 'الاستبدال يتطلب صلاحية المدير',
  'Take photo': 'التقاط صورة',
  'Invoice not found': 'لم يتم العثور على الفاتورة',
  'Sign in to upload': 'سجّل الدخول للرفع',
  'Enter invoice number': 'أدخل رقم الفاتورة',
  'Attach image': 'إرفاق صورة',
  Replace: 'استبدال',
  'Will attach when the order is confirmed': 'سيتم إرفاقها عند تأكيد الطلب',

  // Staff / platform forms (gaps found by src/i18n/translations.test.ts)
  'New User': 'مستخدم جديد',
  '+ Add Staff': '+ إضافة موظف',
  'Username is required': 'اسم المستخدم مطلوب',
  'Password must be at least 6 characters': 'كلمة المرور 6 أحرف على الأقل',
  'Platform access only': 'هذه الصفحة لمشرف المنصة فقط',
  'Store name': 'اسم المتجر',
  'Store name and admin login (6+ chars) are required':
    'اسم المتجر وبيانات دخول المدير (6 أحرف على الأقل) مطلوبة',
  'No license': 'لا يوجد ترخيص',

  // Storage maintenance: orphaned images
  'Orphaned images': 'صور غير مرتبطة',
  'Photos in storage that no invoice references any more - left by a failed checkout or an older build.':
    'صور في التخزين لا يشير إليها أي فاتور بعد - بقيت من عملية دفع فاشلة أو إصدار أقدم.',
  'Scan storage': 'فحص التخزين',
  'Scanning…': 'جارٍ الفحص…',
  'No orphaned images found.': 'لا توجد صور غير مرتبطة.',
  'Reclaimable': 'قابل للاستعادة',
  'files': 'ملفات',
  // 'Delete' already exists in the dictionary (unquoted, line 52) - reusing it
  // rather than adding a duplicate key, which is silently the last one that
  // wins and would drift the two screens apart (025's duplicate-key trap).
  'Some stores could not be scanned': 'تعذّر فحص بعض المتاجر',

  // Order photos
  'Attach': 'إرفاق',
  'Scan this with the phone camera to attach the two photos':
    'امسح هذا الرمز بكاميرا الجوال لإرفاق الصورتين',
  'Invoice not found in the system. Photos will attach when the order is confirmed.':
    'لم يتم العثور على الفاتورة في النظام. سيتم إرفاق الصور عند تأكيد الطلب.',
  'Uploading…': 'جارٍ الرفع',
  'License expired': 'انتهت صلاحية الترخيص',
  'Your data is safe. Contact the vendor to renew the license for': 'بياناتك آمنة. تواصل مع الموزع لتجديد ترخيص',
  'License expired - data is read-only during the grace period. Renew to continue working.': 'انتهت صلاحية الترخيص - البيانات للقراءة فقط خلال فترة السماح. جدّد لمتابعة العمل.',
  Platform: 'المنصة',
  Stores: 'المتاجر',
  'Create store': 'إنشاء متجر',
  'Owner name': 'اسم المالك',
  'Owner phone': 'هاتف المالك',
  'Owner email': 'بريد المالك',
  Plan: 'الخطة',
  Renew: 'تجديد',
  'New expiry date': 'تاريخ الانتهاء الجديد',
  'No stores yet.': 'لا توجد متاجر بعد.',
  // WhatsApp share. The receipt text itself is Arabic (it is the same wording
  // the printed sheet uses); these are the button and its two outcomes.
  'Share on WhatsApp': 'المشاركة عبر واتساب',
  'WhatsApp opened in a new tab.': 'فتحت واتساب واتساب في متصف جديد.',
  'Copied to clipboard - paste it into the chat yourself.':
    'نسخت إلى الحافظرة - الصقها في المحادثة بنفسك.',
  // Used to address the WhatsApp share when a phone is stored in national form.
  'Country Code': 'كود الدولة',
  // Consolidated multi-store reporting (migration 025). The screen shows each
  // store's OWN local day, so the zone column is labelled rather than hidden -
  // a vendor comparing two shops has to see that the figures are not describing
  // the same stretch of time.
  'Revenue across all stores': 'الإيرادات عبر جميع المتاجر',
  'Checking access...': 'جارِ التحقيق من الصلاحية...',
  'Run 025_platform_reports.sql to see revenue across stores.':
    'شغّل 025_platform_reports.sql لعرض الإيرادات عبر المتاجر.',
  Store: 'المتجر',
  Day: 'اليوم',
  // Orders / Paid / Total already existed above and are reused rather than
  // redefined here: a duplicate key is silently the LAST one that wins, which
  // is how a reworded term starts meaning one thing in one screen and another
  // elsewhere.
  Revenue: 'الإيرادات',
  inactive: 'غير نشط',
  'Nothing sold on this day.': 'لا توجد مبيعات في هذا اليوم.',
  'Store admin username': 'اسم مستخدم مدير المتجر',
  'Store admin password': 'كلمة مرور مدير المتجر',
  Expires: 'ينتهي',
  Revoked: 'ملغاة',
  trial: 'تجريبي',
  standard: 'قياسي',
  pro: 'احترافي',
  'No entries yet.': 'لا توجد إدخالات بعد.',
  'Custom order': 'ترتيب مخصص',
  Alphabetical: 'أبجدي',
  'Close the shift': 'إقفال الوردية',
  'Expected in the drawer': 'المتوقع في الخزنة',
  'Count the drawer': 'عدّ الخزنة',
  'Counted cash': 'النقد المعدود',
  'Counted': 'المعدود',
  'Expected amount': 'المتوقع',
  'Variance': 'الفرق',
  'Voids': 'الإلغاءات',
  'Refunds': 'المسترجعات',
  'Lab jobs delivered': 'أعمال المعمل المسلّمة',
  'Closed': 'مُقفل',
  'Closing...': 'جارٍ الإقفال...',
  'Note (optional)': 'ملاحظة (اختياري)',
  'Previous closes': 'الإقفالات السابقة',
  'No shifts have been closed yet.': 'لم يتم إقفال أي وردية بعد.',
  'Shift closed.': 'تم إقفال الوردية.',
  'Could not close the shift.': 'تعذّر إقفال الوردية.',
  'Matches the ledger.': 'مطابق للسجل.',
  'Short of the expected amount.': 'أقل من المبلغ المتوقع.',
  'More than the expected amount.': 'أكثر من المبلغ المتوقع.',
  'Enter the counted cash to see the difference.': 'أدخل النقد المعدود لعرض الفرق.',
  'Enter the cash you counted before closing.': 'أدخل النقد الذي عددته قبل الإقفال.',
  'A close cannot be edited later.': 'لا يمكن تعديل الإقفال لاحقًا.',
  'A close cannot be edited later. Record this close for the day?': 'لا يمكن تعديل الإقفال لاحقًا. هل تسجل هذا الإقفل لليوم؟',
  'The day-close feature is not installed yet.': 'ميزة إقفال اليوم غير مثبتة بعد.',
  'Run 023_z_report.sql and 024_closing_permission.sql in the SQL Editor, then reload.': 'شغّل 023_z_report.sql و 024_closing_permission.sql في محرّر SQL ثم أعد التحميل.',
  'You can see these figures but not record a close. Ask a manager for permission.': 'يمكن رؤية هذه الأرقام لكن لا تستطيع تسجيل إقفال. اطلب الإذن من المدير.',
  'Money is counted net of refunds, so a void leaves the drawer as empty as the sale left it full.': 'تُحسب الموال صافياً من المسترجعات، لذلك يترك الإلغاء الخزنة فارغة كما تركتها ممتلئة.',
  'Lens types and colors used in prescriptions. Ask a manager to change these.': 'انوانع العدسات العدسةةات المستخدمةة في الوصفات. اطلب المدير لتغييرها.',
}
