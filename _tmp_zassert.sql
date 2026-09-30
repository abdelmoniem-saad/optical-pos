
-- ===== impersonate the manager =============================================
set role authenticated;
select _imp('eeeeeeee-eeee-4eee-8eee-000000000041');

-- ===== G-Z1: the report exists ==============================================
select has_function('public', 'z_report',
  'G-Z1 z_report exists, so the drawer question is answerable');

-- ===== G-Z2: expected_cash is the NET of payments and refunds ================
-- 1000 cash (Z1) + 500 cash (Z2) - 400 cash refund (Z2) = 1100. The voided
-- Z3 contributes 0 and is asserted separately below.
select is((select expected_cash::bigint from public.z_report(_z_from(), _z_to())), 1100::bigint,
  'G-Z2 expected cash is net of refunds, and the refund came off CASH specifically');

-- The wallet tender is in the total but NOT in the cash, which is the whole
-- distinction between "expected" and "in the drawer".
select is((select expected_total::bigint from public.z_report(_z_from(), _z_to())), 1600::bigint,
  'G-Z2b expected total includes the wallet tender the drawer will not hold');

select is((select refund_total::bigint from public.z_report(_z_from(), _z_to())), 1300::bigint,
  'G-Z2c refunds are reported as a positive figure (1300 = 400 plus the 900 void reversal)');

-- ===== G-Z3: a void nets to zero in the drawer ==============================
-- The property this whole design rests on. Z3 took 900 cash and void_sale wrote
-- -900 cash, so the drawer is unaffected - NOT because voided sales are filtered
-- out (they are not, anywhere in this function) but because the money cancelled
-- itself in the sum.
--
-- If a future edit "fixed" a wrong number here by excluding voided sales, this
-- would still pass while the refund semantics quietly changed underneath. The
-- refund is the mechanism; a filter would be a different, wrong mechanism.
select is((select expected_cash::bigint from public.z_report(_z_from(), _z_to()))
          - 1100::bigint, 0::bigint,
  'G-Z3 a voided 900 cash sale leaves the drawer at 1100 - the reversal cancelled it');

select is((select void_count::bigint from public.z_report(_z_from(), _z_to())), 1::bigint,
  'G-Z3b and the void is still REPORTED, not silently dropped - a mistaken void must not look like a quiet day');

-- ===== G-Z4: a prescription is not a billable order =========================
-- 022's kind, reused. Z1, Z2, Z3 are sales; Z4 is a prescription with no money.
-- Counting it would inflate the day's order count for work nobody paid for.
select is((select order_count::bigint from public.z_report(_z_from(), _z_to())), 3::bigint,
  'G-Z4 the prescription is not counted as an order');
select is((select prescription_count::bigint from public.z_report(_z_from(), _z_to())), 1::bigint,
  'G-Z4b ...but it is counted separately, so it is visible rather than invisible');
