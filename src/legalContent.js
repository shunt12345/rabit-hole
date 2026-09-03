// Production punch list, Section I (legal/compliance). Flagged urgent once
// billing (Section D) went live with real payments and real user accounts —
// until this existed there was no Terms of Service or Privacy Policy
// anywhere in the app. This is a reasonable starting draft, not a
// substitute for review by an actual attorney before wider launch,
// especially for anything jurisdiction-specific (GDPR/CCPA rights,
// dispute-resolution clauses, tax treatment of balance top-ups, etc.).
//
// Content is generated using automated language-processing technology,
// including large language models — noted factually here because
// disclosure obligations attach to what the product IS, not to how it's
// marketed. That's a separate question from the UI's own wording choices
// (which deliberately avoid branding the product around "AI").
export const LEGAL_LAST_UPDATED = "September 3, 2026";

export const TERMS_SECTIONS = [
  {
    heading: "1. Acceptance of these terms",
    body: `By creating an account or using Hypha ("the Service"), you agree to these Terms of Service. If you don't agree, don't use the Service.`,
  },
  {
    heading: "2. What Hypha is",
    body: `Hypha lets you explore a topic by generating related threads, articles, and summaries on demand. Content is produced automatically, on request, using automated language-processing technology. It is not written or reviewed by a human before it's shown to you, and it can be incomplete, out of date, or wrong.`,
  },
  {
    heading: "3. Not professional advice",
    body: `Nothing in the Service is medical, legal, financial, or other professional advice. Don't rely on generated content for decisions where being wrong would matter — verify anything important against a primary source.`,
  },
  {
    heading: "4. Accounts",
    body: `You need an account to use most of the Service beyond a limited free daily allowance. You're responsible for keeping access to your email/sign-in method secure, and for activity that happens under your account.`,
  },
  {
    heading: "5. Balance, purchases, and billing",
    body: `Some features require a positive account balance, added by purchasing credit through our payment processor (Stripe). Charges are billed against your balance as you use metered features; unused balance does not expire on its own but is not a store of value, isn't interest-bearing, and isn't redeemable for cash except where required by law. Purchases are generally final and non-refundable, except as required by applicable law or at our discretion. Prices and what's metered can change; we'll make reasonable efforts to reflect changes in the product before they take effect.`,
  },
  {
    heading: "6. Free tier",
    body: `Signed-out and low-balance use is subject to a daily usage limit that we may change at any time without notice.`,
  },
  {
    heading: "7. Acceptable use",
    body: `Don't use the Service to generate or distribute unlawful content, attempt to disrupt or reverse-engineer the Service, circumvent usage limits or billing, or scrape/automate access outside of what a normal person using the product would do.`,
  },
  {
    heading: "8. Intellectual property",
    body: `We and our licensors own the Service itself (software, design, branding). Subject to these Terms, you may use content generated for you through the Service for your own personal or internal purposes. We make no claim of ownership over the specific text generated in response to your inputs, but we don't warrant that it's free of third-party rights.`,
  },
  {
    heading: "9. Termination",
    body: `You can stop using the Service and close your account at any time. We may suspend or terminate access for violation of these Terms, non-payment, suspected fraud or abuse, or to comply with law. Remaining balance handling on termination will follow applicable law.`,
  },
  {
    heading: "10. Disclaimers and limitation of liability",
    body: `The Service is provided "as is" without warranties of any kind, express or implied, including accuracy, fitness for a particular purpose, or non-infringement. To the maximum extent permitted by law, we are not liable for indirect, incidental, or consequential damages, and our total liability for any claim relating to the Service is limited to the amount you paid us in the 3 months before the claim arose.`,
  },
  {
    heading: "11. Changes to these terms",
    body: `We may update these Terms from time to time. Continued use of the Service after an update means you accept the revised Terms. Material changes will be reflected by updating the date below.`,
  },
  {
    heading: "12. Contact",
    body: `Questions about these Terms can be sent to the account/support address for the Service.`,
  },
];

export const PRIVACY_SECTIONS = [
  {
    heading: "1. What we collect",
    body: `Account information you provide (email address); usage data (topics explored, feature activity, timestamps) needed to operate the free-tier limit and billing; and payment activity (handled by our payment processor — we don't receive or store your card number).`,
  },
  {
    heading: "2. How we use it",
    body: `To operate your account and sign-in, enforce free-tier limits, meter and bill usage against your balance, deliver the product features you've enabled, keep the Service reliable and secure, and improve it over time.`,
  },
  {
    heading: "3. Who we share it with",
    body: `We share data with the vendors that help us run the Service, and only as needed for that purpose: our backend/database/authentication provider (Supabase), our payment processor (Stripe), and a third-party text-generation API provider used to produce content. We don't sell your personal information.`,
  },
  {
    heading: "4. Local storage",
    body: `The app stores small pieces of state on your device (such as cached news content and session info) to make repeat visits faster. This stays on your device and isn't a tracking mechanism for other sites.`,
  },
  {
    heading: "5. Data retention",
    body: `We keep account and usage data for as long as your account is active, and for a reasonable period after that for billing records, fraud prevention, and legal compliance.`,
  },
  {
    heading: "6. Your choices",
    body: `You can request access to or deletion of your account data by contacting us. Deleting your account does not retroactively erase billing records we're required to keep.`,
  },
  {
    heading: "7. Children's privacy",
    body: `The Service isn't directed to children under 13, and we don't knowingly collect personal information from them. If you believe a child has provided us information, contact us and we'll delete it.`,
  },
  {
    heading: "8. Security",
    body: `We use reasonable technical and organizational measures to protect your data, but no method of transmission or storage is 100% secure.`,
  },
  {
    heading: "9. Changes to this policy",
    body: `We may update this Privacy Policy from time to time. Continued use of the Service after an update means you accept the revised policy. Material changes will be reflected by updating the date below.`,
  },
  {
    heading: "10. Contact",
    body: `Questions about this Privacy Policy can be sent to the account/support address for the Service.`,
  },
];
