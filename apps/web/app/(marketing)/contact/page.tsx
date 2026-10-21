import type { Metadata } from "next";
import { Prose } from "@/components/site/prose";
import { getConfig } from "@flock/core/config";

export const metadata: Metadata = { title: "Contact" };

export default function ContactPage() {
  const { supportEmail, telegram } = getConfig();
  return (
    <Prose title="Contact">
      <p>
        Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a> and we&apos;ll get back to you.
      </p>
      <h2>Members</h2>
      <p>
        For questions about a specific community&apos;s content or refunds, contact the creator first. Their support contact is on their membership page, and
        you can also send <strong>/support</strong> to{" "}
        <a href={`https://t.me/${telegram.botUsername}`} rel="noopener noreferrer">
          @{telegram.botUsername}
        </a>
        .
      </p>
      <p>
        To cancel or update your card, go to <a href="/account">My memberships</a>.
      </p>
      <h2>Creators</h2>
      <p>Include your community&apos;s address (useflock.co/join/…) so we can find it quickly. Never send us your Stripe keys or passwords.</p>
    </Prose>
  );
}
