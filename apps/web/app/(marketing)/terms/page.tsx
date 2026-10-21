import type { Metadata } from "next";
import { LegalDraftNote } from "@/components/site/legal-draft-note";
import { Prose } from "@/components/site/prose";
import { getConfig } from "@flock/core/config";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  const support = getConfig().supportEmail;
  return (
    <Prose title="Terms of Service" updated="October 21, 2026">
      <LegalDraftNote />
      <p>
        These terms cover your use of Flock (useflock.co), a service that lets creators sell memberships to private Telegram channels and groups. By using
        Flock you agree to them.
      </p>
      <h2>What Flock does</h2>
      <p>
        Flock connects a creator&apos;s Telegram chat and Stripe account, shows a membership page, and uses a Telegram bot to invite paying members and remove
        members whose access has ended. Flock is not Telegram and is not affiliated with Telegram.
      </p>
      <h2>Creators</h2>
      <ul>
        <li>You sell memberships in your own name. Payments are made to your Stripe account, and you are the merchant of record.</li>
        <li>You are responsible for your community&apos;s content, refunds, taxes, and complying with Stripe&apos;s and Telegram&apos;s terms.</li>
        <li>You must not use Flock for content or businesses that Stripe or Telegram prohibit, or that are illegal where you or your members are.</li>
        <li>You must keep the Flock bot as an administrator with the rights it asks for, or Flock cannot manage access.</li>
      </ul>
      <h2>Members</h2>
      <ul>
        <li>Your membership is a contract with the creator. Billing is handled by Stripe, and you can cancel any time from your account page.</li>
        <li>Access is personal to the Telegram account you signed in with. Invite links are single-use and only work for you.</li>
        <li>When a membership ends, is refunded, or is disputed, the bot removes you from the chat.</li>
      </ul>
      <h2>Fees</h2>
      <p>Flock is free during early access. If that changes, creators will be told in advance. Stripe charges its own processing fees.</p>
      <h2>Availability</h2>
      <p>
        We work to keep Flock running and to keep access correct, but we can&apos;t promise uninterrupted service. Telegram and Stripe outages can delay
        invites or removals.
      </p>
      <h2>Ending your use</h2>
      <p>
        Creators can unpublish their page at any time. We may suspend accounts that break these terms. Disconnecting a chat with active members is blocked
        until their paid access ends.
      </p>
      <h2>Contact</h2>
      <p>
        Questions: <a href={`mailto:${support}`}>{support}</a>
      </p>
    </Prose>
  );
}
