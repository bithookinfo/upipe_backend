INSERT INTO subscription_plans
  (id, name, code, description, price, currency, billing_cycle,
   trial_days, max_users, max_merchants, max_transactions, max_api_calls,
   features, is_active, is_public, is_featured, sort_order,
   created_at, updated_at, deleted_at)
VALUES
  (UUID(), 'Starter',    'STARTER_QTR',    'Starter quarterly plan (10% more requests)', 3899,  'INR', 'QUARTERLY',
   0, 5, 3, 1000, 10000,
   JSON_ARRAY(
     '16,499 QR Code Request',
     '0 Transaction Fee *',
     'Realtime Transaction',
     'No Amount Limit',
     'Zero Setup Charge',
     'Migration Assistance',
     '24*7 Whatsapp Support',
     'Remove Branding',
     'Direct Intent *',
     'Incognito Payment URL',
     'Allow connecting multiple merchants',
     'Support Special & Star Merchant *'
   ),
   1, 1, 0, 50,
   NOW(), NOW(), NULL),

  (UUID(), 'Startup',    'STARTUP_QTR',    'Startup quarterly plan (10% more requests)', 5999,  'INR', 'QUARTERLY',
   0, 15, 10, 5000, 50000,
   JSON_ARRAY(
     '28,399 QR Code Request',
     '0 Transaction Fee *',
     'Realtime Transaction',
     'No Amount Limit',
     'Zero Setup Charge',
     'Migration Assistance',
     '24*7 Whatsapp Support',
     'Remove Branding',
     'Direct Intent *',
     'Incognito Payment URL',
     'Allow connecting multiple merchants',
     'Support Special & Star Merchant *'
   ),
   1, 1, 0, 60,
   NOW(), NOW(), NULL),

  (UUID(), 'Business',   'BUSINESS_QTR',   'Business quarterly plan (10% more requests)', 7499,  'INR', 'QUARTERLY',
   0, 50, 25, 25000, 250000,
   JSON_ARRAY(
     '39,599 QR Code Request',
     '0 Transaction Fee *',
     'Realtime Transaction',
     'No Amount Limit',
     'Zero Setup Charge',
     'Migration Assistance',
     '24*7 Whatsapp Support',
     'Remove Branding',
     'Direct Intent *',
     'Incognito Payment URL',
     'Allow connecting multiple merchants',
     'Support Special & Star Merchant *'
   ),
   1, 1, 1, 70,
   NOW(), NOW(), NULL),

  (UUID(), 'Business +', 'BUSINESS_PLUS_QTR','Business+ quarterly plan (10% more requests)', 14999, 'INR', 'QUARTERLY',
   0, 100, 50, 50000, 500000,
   JSON_ARRAY(
     '82,449 QR Code Request',
     '0 Transaction Fee *',
     'Realtime Transaction',
     'No Amount Limit',
     'Zero Setup Charge',
     'Migration Assistance',
     '24*7 Whatsapp Support',
     'Remove Branding',
     'Direct Intent *',
     'Incognito Payment URL',
     'Allow connecting multiple merchants',
     'Support Special & Star Merchant *'
   ),
   1, 1, 0, 80,
   NOW(), NOW(), NULL);

