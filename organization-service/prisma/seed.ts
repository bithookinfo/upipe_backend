import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Upipe CMS Data...');

  // 1. Global SEO
  await prisma.cmsGlobalSeo.upsert({
    where: { id: 'global-seo' },
    update: {},
    create: {
      id: 'global-seo',
      siteName: 'Upipe',
      siteDescription: 'Modern payments and business management system. Perfect for growing organizations.',
      defaultTitle: 'Upipe - The Ultimate Platform',
      defaultDescription: 'Empower your organization with our state-of-the-art cloud-based system.',
      defaultKeywords: 'payments, business management, upipe, saas',
    },
  });

  // 2. Brand Assets
  await prisma.cmsBrandAsset.upsert({
    where: { id: 'brand-assets' },
    update: {},
    create: {
      id: 'brand-assets',
      primaryColor: '#4f46e5',
      secondaryColor: '#10b981',
      accentColor: '#f59e0b',
    },
  });

  // 3. Pages
  const homePage = await prisma.cmsPage.upsert({
    where: { slug: 'home' },
    update: {},
    create: {
      id: 'page-home',
      title: 'Home',
      slug: 'home',
      content: 'Welcome to Upipe',
      status: 'published',
      seoTitle: 'Upipe - Modern Payments',
    },
  });

  const faqPage = await prisma.cmsPage.upsert({
    where: { slug: 'faq' },
    update: {},
    create: {
      id: 'page-faq',
      title: 'FAQ',
      slug: 'faq',
      content: 'Frequently Asked Questions',
      status: 'published',
    },
  });

  const contactPage = await prisma.cmsPage.upsert({
    where: { slug: 'contact' },
    update: {},
    create: {
      id: 'page-contact',
      title: 'Contact Us',
      slug: 'contact',
      content: 'Get in touch with us',
      status: 'published',
    },
  });

  const termsPage = await prisma.cmsPage.upsert({
    where: { slug: 'terms' },
    update: {},
    create: {
      id: 'page-terms',
      title: 'Terms & Conditions',
      slug: 'terms',
      content: 'Our Terms and Conditions',
      status: 'published',
    },
  });

  const privacyPage = await prisma.cmsPage.upsert({
    where: { slug: 'privacy' },
    update: {},
    create: {
      id: 'page-privacy',
      title: 'Privacy Policy',
      slug: 'privacy',
      content: 'Our Privacy Policy',
      status: 'published',
    },
  });

  const refundPage = await prisma.cmsPage.upsert({
    where: { slug: 'refund' },
    update: {},
    create: {
      id: 'page-refund',
      title: 'Refund Policy',
      slug: 'refund',
      content: 'Our Refund Policy',
      status: 'published',
    },
  });

  // 4. Hero Section
  await prisma.cmsSection.upsert({
    where: { id: 'section-home-hero' },
    update: {
      content: JSON.stringify({
        badgeText: 'Built for modern UPI collections',
        mainHeading: 'Dynamic QR and payment links',
        highlightHeading: 'for faster collections.',
        description: 'Generate order-linked dynamic QR, track payment lifecycle, and monitor webhook updates from one operations dashboard.\n\nUpipe provides dynamic QR and payment orchestration tooling. It does not provide banking or merchant UPI accounts.',
        primaryButtonText: 'Create Account',
        primaryButtonUrl: '/register',
        secondaryButtonText: 'See How It Works',
        secondaryButtonUrl: '/#how-it-works',
        heroImageUrl: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=800&q=80',
        trustOrderTitle: 'Real-Time',
        trustOrderSub: 'Order visibility',
        trustWebhookTitle: 'Webhook',
        trustWebhookSub: 'Status updates',
        trustMultiTitle: 'Multi-App',
        trustMultiSub: 'UPI acceptance',
        trustZeroFeeTitle: '0% Fees',
        trustZeroFeeSub: 'Zero setup cost'
      })
    },
    create: {
      id: 'section-home-hero',
      pageSlug: 'home',
      pageId: homePage.id,
      sectionType: 'hero',
      content: JSON.stringify({
        badgeText: 'Built for modern UPI collections',
        mainHeading: 'Dynamic QR and payment links',
        highlightHeading: 'for faster collections.',
        description: 'Generate order-linked dynamic QR, track payment lifecycle, and monitor webhook updates from one operations dashboard.\n\nUpipe provides dynamic QR and payment orchestration tooling. It does not provide banking or merchant UPI accounts.',
        primaryButtonText: 'Create Account',
        primaryButtonUrl: '/register',
        secondaryButtonText: 'See How It Works',
        secondaryButtonUrl: '/#how-it-works',
        heroImageUrl: 'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=800&q=80',
        trustOrderTitle: 'Real-Time',
        trustOrderSub: 'Order visibility',
        trustWebhookTitle: 'Webhook',
        trustWebhookSub: 'Status updates',
        trustMultiTitle: 'Multi-App',
        trustMultiSub: 'UPI acceptance',
        trustZeroFeeTitle: '0% Fees',
        trustZeroFeeSub: 'Zero setup cost'
      }),
      order: 1,
    }
  });

  // 5. Features Section
  await prisma.cmsSection.upsert({
    where: { id: 'section-home-features' },
    update: {
      content: JSON.stringify({
        heading: 'Built for real UPI operations',
        description: 'These capabilities map to screens and flows in client admin: dashboard, orders, QR, merchants, providers, routing, API keys, webhooks, and docs—not a separate marketing stack.',
        features: [
          { title: 'Organization dashboard', description: 'See revenue and order trends, drill into transactions, and filter by date range—the same metrics views merchants use after sign-in.', icon: 'LayoutDashboard' },
          { title: 'Orders & payment links', description: 'Create orders with customer context, share payment links, and follow status from pending through success or failure in the orders workspace.', icon: 'Link' },
          { title: 'Dynamic QR generation', description: 'Generate order-aware UPI QR codes with amount and payee context from the QR tools and order flows you already run in admin.', icon: 'QrCode' },
          { title: 'Providers & routing', description: 'Connect supported UPI providers per merchant and tune routing (priority, load balance, or single route) from the Providers and routing screens.', icon: 'Network' },
          { title: 'Merchants & configuration', description: 'Onboard merchants, complete business profiles, manage limits and hours, and map providers without leaving the merchant admin workflows.', icon: 'Store' },
          { title: 'API keys, webhooks & docs', description: 'Issue API keys, configure callback URLs, inspect delivery logs and retries, and integrate using the in-product API documentation.', icon: 'Code' }
        ]
      })
    },
    create: {
      id: 'section-home-features',
      pageSlug: 'home',
      pageId: homePage.id,
      sectionType: 'features',
      content: JSON.stringify({
        heading: 'Built for real UPI operations',
        description: 'These capabilities map to screens and flows in client admin: dashboard, orders, QR, merchants, providers, routing, API keys, webhooks, and docs—not a separate marketing stack.',
        features: [
          { title: 'Organization dashboard', description: 'See revenue and order trends, drill into transactions, and filter by date range—the same metrics views merchants use after sign-in.', icon: 'LayoutDashboard' },
          { title: 'Orders & payment links', description: 'Create orders with customer context, share payment links, and follow status from pending through success or failure in the orders workspace.', icon: 'Link' },
          { title: 'Dynamic QR generation', description: 'Generate order-aware UPI QR codes with amount and payee context from the QR tools and order flows you already run in admin.', icon: 'QrCode' },
          { title: 'Providers & routing', description: 'Connect supported UPI providers per merchant and tune routing (priority, load balance, or single route) from the Providers and routing screens.', icon: 'Network' },
          { title: 'Merchants & configuration', description: 'Onboard merchants, complete business profiles, manage limits and hours, and map providers without leaving the merchant admin workflows.', icon: 'Store' },
          { title: 'API keys, webhooks & docs', description: 'Issue API keys, configure callback URLs, inspect delivery logs and retries, and integrate using the in-product API documentation.', icon: 'Code' }
        ]
      }),
      order: 2,
    }
  });

  // 6. Use Cases (Trust)
  await prisma.cmsSection.upsert({
    where: { id: 'section-home-trust' },
    update: {
      content: JSON.stringify({
        heading: 'Built for every collection scenario',
        useCases: [
          { title: 'Checkout on web and mobile', description: 'Show dynamic QR and payment links at checkout and confirm status in real time.' },
          { title: 'Subscriptions for OTT and Smart TV', description: 'Collect UPI payments for renewals and plans with quick scan flow and webhook-led fulfillment.' },
          { title: 'In-store and counter collections', description: 'Display amount-bound QR on POS counters and reduce manual entry errors.' },
          { title: 'Self-serve kiosks and vending', description: 'Run unattended UPI collection with clear audit trails and order-level tracking.' }
        ]
      })
    },
    create: {
      id: 'section-home-trust',
      pageSlug: 'home',
      pageId: homePage.id,
      sectionType: 'trust',
      content: JSON.stringify({
        heading: 'Built for every collection scenario',
        useCases: [
          { title: 'Checkout on web and mobile', description: 'Show dynamic QR and payment links at checkout and confirm status in real time.' },
          { title: 'Subscriptions for OTT and Smart TV', description: 'Collect UPI payments for renewals and plans with quick scan flow and webhook-led fulfillment.' },
          { title: 'In-store and counter collections', description: 'Display amount-bound QR on POS counters and reduce manual entry errors.' },
          { title: 'Self-serve kiosks and vending', description: 'Run unattended UPI collection with clear audit trails and order-level tracking.' }
        ]
      }),
      order: 3,
    }
  });

  // 7. Benefits
  await prisma.cmsSection.upsert({
    where: { id: 'section-home-benefits' },
    update: {
      content: JSON.stringify({
        heading: 'Premium infrastructure for UPI payment operations',
        description: 'Dynamic QR, centralized orders, webhook notifications, and multi-provider compatibility so teams can collect confidently at scale.',
        benefits: [
          { title: 'Faster checkout', description: 'Generate amount-bound QR and shareable payment links in seconds.' },
          { title: 'Verified payment flows', description: 'Track each order state from pending to success with clear status visibility.' },
          { title: 'Analytics that matter', description: 'Monitor success rates, order trends, and merchant performance from one place.' },
          { title: 'Merchant-first support', description: 'Use in-app support and contact options while you connect providers, verify webhooks, and roll out to customers.' },
          { title: 'Audit-ready logs', description: 'Timeline events, callback attempts, and transaction references in one workspace.' },
          { title: 'API + webhook native', description: 'Integrate cleanly with backend systems using APIs and event callbacks.' }
        ]
      })
    },
    create: {
      id: 'section-home-benefits',
      pageSlug: 'home',
      pageId: homePage.id,
      sectionType: 'benefits',
      content: JSON.stringify({
        heading: 'Premium infrastructure for UPI payment operations',
        description: 'Dynamic QR, centralized orders, webhook notifications, and multi-provider compatibility so teams can collect confidently at scale.',
        benefits: [
          { title: 'Faster checkout', description: 'Generate amount-bound QR and shareable payment links in seconds.' },
          { title: 'Verified payment flows', description: 'Track each order state from pending to success with clear status visibility.' },
          { title: 'Analytics that matter', description: 'Monitor success rates, order trends, and merchant performance from one place.' },
          { title: 'Merchant-first support', description: 'Use in-app support and contact options while you connect providers, verify webhooks, and roll out to customers.' },
          { title: 'Audit-ready logs', description: 'Timeline events, callback attempts, and transaction references in one workspace.' },
          { title: 'API + webhook native', description: 'Integrate cleanly with backend systems using APIs and event callbacks.' }
        ]
      }),
      order: 4,
    }
  });

  // 8. How It Works
  await prisma.cmsSection.upsert({
    where: { id: 'section-home-how-it-works' },
    update: {
      content: JSON.stringify({
        heading: 'How Upipe Dynamic QR works',
        steps: [
          { title: 'Customer starts checkout', description: 'The customer selects products on your site and proceeds to checkout.' },
          { title: 'Dynamic QR is generated', description: 'At checkout, Upipe generates a dynamic QR and payment context for the order.' },
          { title: 'Payment is confirmed', description: 'The customer pays with any supported UPI app by scanning the QR or using the payment link.' },
          { title: 'Webhook notification', description: 'Upipe verifies the outcome and notifies your systems through webhooks and dashboard updates.' }
        ]
      })
    },
    create: {
      id: 'section-home-how-it-works',
      pageSlug: 'home',
      pageId: homePage.id,
      sectionType: 'how-it-works',
      content: JSON.stringify({
        heading: 'How Upipe Dynamic QR works',
        steps: [
          { title: 'Customer starts checkout', description: 'The customer selects products on your site and proceeds to checkout.' },
          { title: 'Dynamic QR is generated', description: 'At checkout, Upipe generates a dynamic QR and payment context for the order.' },
          { title: 'Payment is confirmed', description: 'The customer pays with any supported UPI app by scanning the QR or using the payment link.' },
          { title: 'Webhook notification', description: 'Upipe verifies the outcome and notifies your systems through webhooks and dashboard updates.' }
        ]
      }),
      order: 5,
    }
  });

  // 9. Providers
  await prisma.cmsSection.upsert({
    where: { id: 'section-home-providers' },
    update: {
      content: JSON.stringify({
        heading: 'Compatible with major UPI apps',
        description: 'Connect supported providers and monitor collections from one admin dashboard',
      })
    },
    create: {
      id: 'section-home-providers',
      pageSlug: 'home',
      pageId: homePage.id,
      sectionType: 'providers',
      content: JSON.stringify({
        heading: 'Compatible with major UPI apps',
        description: 'Connect supported providers and monitor collections from one admin dashboard',
      }),
      order: 6,
    }
  });

  // 10. FAQ Page Section
  await prisma.cmsSection.upsert({
    where: { id: 'section-faq-faqs' },
    update: {
      content: JSON.stringify({
        heading: 'Frequently Asked Questions',
        faqs: [
          { question: 'What is Upipe?', answer: 'Upipe is a UPI collection platform for businesses. You can generate dynamic QR and payment links, track orders, view transaction attempts, and monitor payment outcomes from one dashboard.' },
          { question: 'Which providers are supported?', answer: 'Based on current product support, merchants can connect PhonePe, Paytm, Google Pay, and BharatPe.' },
          { question: 'Do you support API and webhooks?', answer: 'Yes. Upipe provides API-based order creation and status checks, plus webhook callbacks for payment status updates and retries.' },
          { question: 'Can I manage multiple merchants and teams?', answer: 'Yes. The admin platform includes merchant configuration, provider mapping, API key management, organization settings, and organization user management.' }
        ]
      })
    },
    create: {
      id: 'section-faq-faqs',
      pageSlug: 'faq',
      pageId: faqPage.id,
      sectionType: 'faqs',
      content: JSON.stringify({
        heading: 'Frequently Asked Questions',
        faqs: [
          { question: 'What is Upipe?', answer: 'Upipe is a UPI collection platform for businesses. You can generate dynamic QR and payment links, track orders, view transaction attempts, and monitor payment outcomes from one dashboard.' },
          { question: 'Which providers are supported?', answer: 'Based on current product support, merchants can connect PhonePe, Paytm, Google Pay, and BharatPe.' },
          { question: 'Do you support API and webhooks?', answer: 'Yes. Upipe provides API-based order creation and status checks, plus webhook callbacks for payment status updates and retries.' },
          { question: 'Can I manage multiple merchants and teams?', answer: 'Yes. The admin platform includes merchant configuration, provider mapping, API key management, organization settings, and organization user management.' }
        ]
      }),
      order: 1,
    }
  });

  // 11. Contact Section
  await prisma.cmsSection.upsert({
    where: { id: 'section-contact-info' },
    update: {
      content: JSON.stringify({
        companyName: 'Upipe',
        email: 'support@upipe.tech',
        phone: '+91 8055558292',
        address: 'Call us between 10 a.m. to 8 p.m. on all days except public holidays.',
        facebookUrl: '',
        twitterUrl: '',
        linkedinUrl: ''
      })
    },
    create: {
      id: 'section-contact-info',
      pageSlug: 'contact',
      pageId: contactPage.id,
      sectionType: 'contact',
      content: JSON.stringify({
        companyName: 'Upipe',
        email: 'support@upipe.tech',
        phone: '+91 8055558292',
        address: 'Call us between 10 a.m. to 8 p.m. on all days except public holidays.',
        facebookUrl: '',
        twitterUrl: '',
        linkedinUrl: ''
      }),
      order: 1,
    }
  });

  // 12. Navigation
  await prisma.cmsNavigation.upsert({
    where: { id: 'nav-main-home' },
    update: { url: '/', label: 'Home' },
    create: {
      id: 'nav-main-home',
      label: 'Home',
      url: '/',
      navType: 'main',
      order: 1,
    }
  });
  
  await prisma.cmsNavigation.upsert({
    where: { id: 'nav-main-faq' },
    update: { url: '/faq', label: 'FAQ' },
    create: {
      id: 'nav-main-faq',
      label: 'FAQ',
      url: '/faq',
      navType: 'main',
      order: 2,
    }
  });

  await prisma.cmsNavigation.upsert({
    where: { id: 'nav-main-contact' },
    update: { url: '/contact', label: 'Contact Us' },
    create: {
      id: 'nav-main-contact',
      label: 'Contact Us',
      url: '/contact',
      navType: 'main',
      order: 3,
    }
  });
  
  console.log('✅ CMS Navigation seeded (Home, FAQ, Contact Us)');

  // 13. Footer Categories & Navigation
  const legalCategory = await prisma.cmsFooterCategory.upsert({
    where: { id: 'cat-legal' },
    update: { name: 'Legal', displayOrder: 1 },
    create: {
      id: 'cat-legal',
      name: 'Legal',
      displayOrder: 1,
    }
  });

  const supportCategory = await prisma.cmsFooterCategory.upsert({
    where: { id: 'cat-support' },
    update: { name: 'Support', displayOrder: 2 },
    create: {
      id: 'cat-support',
      name: 'Support',
      displayOrder: 2,
    }
  });

  await prisma.cmsNavigation.upsert({
    where: { id: 'nav-footer-terms' },
    update: { url: '/terms', label: 'Terms & Conditions', footerCategoryId: legalCategory.id },
    create: {
      id: 'nav-footer-terms',
      label: 'Terms & Conditions',
      url: '/terms',
      navType: 'footer',
      footerCategoryId: legalCategory.id,
      order: 1,
    }
  });

  await prisma.cmsNavigation.upsert({
    where: { id: 'nav-footer-privacy' },
    update: { url: '/privacy', label: 'Privacy Policy', footerCategoryId: legalCategory.id },
    create: {
      id: 'nav-footer-privacy',
      label: 'Privacy Policy',
      url: '/privacy',
      navType: 'footer',
      footerCategoryId: legalCategory.id,
      order: 2,
    }
  });

  await prisma.cmsNavigation.upsert({
    where: { id: 'nav-footer-contact' },
    update: { url: '/contact', label: 'Contact Support', footerCategoryId: supportCategory.id },
    create: {
      id: 'nav-footer-contact',
      label: 'Contact Support',
      url: '/contact',
      navType: 'footer',
      footerCategoryId: supportCategory.id,
      order: 1,
    }
  });

  console.log('✅ CMS Footer Categories & Navigation seeded');

  console.log('\\n🎉 Comprehensive Upipe CMS seed complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
