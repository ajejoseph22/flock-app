import type { Metadata } from "next";
import { LegalDraftNote } from "@/components/site/legal-draft-note";
import { Prose } from "@/components/site/prose";
import { getConfig } from "@flock/core/config";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  const support = getConfig().supportEmail;
  return (
    <Prose title="Privacy Policy" updated="October 21, 2026">
      <LegalDraftNote />
      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Telegram profile:</strong> your Telegram user ID, name and username, received when you sign in through the Flock bot.
        </li>
        <li>
          <strong>Membership records:</strong> which communities you joined, subscription status and dates, and amounts paid, synced from Stripe.
        </li>
        <li>
          <strong>Creator details:</strong> the contact email you give us when connecting Stripe, and your community settings.
        </li>
        <li>
          <strong>Operational logs:</strong> IP address and browser user agent on sign-in sessions, and an audit trail of access changes.
        </li>
      </ul>
      <h2>What we don&apos;t collect</h2>
      <p>
        We never see or store card numbers. Payments are entered on Stripe&apos;s pages. We do not read messages in your Telegram chats; the bot only receives
        membership events and messages sent directly to it.
      </p>
      <h2>Who we share with</h2>
      <ul>
        <li>Stripe, to process payments on the creator&apos;s account.</li>
        <li>Telegram, to send invites, approve join requests and remove members.</li>
        <li>The creator of a community you join, who can see your Telegram name, username and membership status.</li>
        <li>Our hosting provider, which stores the database.</li>
      </ul>
      <h2>Analytics</h2>
      <p>We record product events (for example &ldquo;checkout started&rdquo;) in our own database. We don&apos;t use third-party advertising trackers.</p>
      <h2>Retention</h2>
      <p>Sign-in challenges expire after minutes and are deleted within a day. Processed webhook payloads are pruned after 30 days. Membership and audit records are kept while the community exists, for billing and dispute history.</p>
      <h2>Your choices</h2>
      <p>
        You can sign out at any time and cancel memberships from your account page. To request a copy or deletion of your data, email{" "}
        <a href={`mailto:${support}`}>{support}</a>. Some records may need to be kept for legal or accounting reasons.
      </p>
    </Prose>
  );
}
