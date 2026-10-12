import type { Locale } from '@luma/i18n/locales';
import { m } from '@luma/i18n/messages';
import type { ReactNode } from 'react';
import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Row,
  Section,
  Text,
} from 'react-email';

/*
 * Brand values copied from the light and dark tokens in @luma/ui. Email clients don't read CSS
 * variables, so the light theme is inlined and Apple Mail and Outlook for Mac switch to the
 * dark theme through the media query below. Clients that invert colors themselves get a light
 * card on a light page, which survives inversion.
 */
const color = {
  page: '#f4f5f8',
  card: '#ffffff',
  tile: '#f1f3f6',
  line: '#e3e5ea',
  text: '#15171c',
  muted: '#4a5163',
  subtle: '#5f6779',
  accent: '#2b63f6',
  link: '#2454cc',
  brand: '#316bff',
};
const font =
  "'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const darkTheme = `
:root { color-scheme: light dark; supported-color-schemes: light dark; }
@media (prefers-color-scheme: dark) {
  .luma-page, .luma-page > table > tbody > tr > td { background-color: #0b1020 !important; }
  .luma-card { background-color: #141b2f !important; border-color: #ffffff24 !important; }
  .luma-tile { background-color: #1c2440 !important; }
  .luma-text { color: #f2f4f9 !important; }
  .luma-muted { color: #b3bcce !important; }
  .luma-link { color: #7db8ff !important; }
}`;

/** Why the person receives the message; shown in the footer of every email. */
export type EmailReason =
  | { kind: 'workspace'; workspace: string; preferencesLink?: string }
  | { kind: 'invitation' }
  | { kind: 'account' };

/**
 * The shared frame of every Luma email: language, preview text, wordmark, a card with the
 * heading and content, and a footer that says why the person received it.
 */
export function EmailLayout(props: {
  locale: Locale;
  preview: string;
  heading: string;
  reason: EmailReason;
  children: ReactNode;
}) {
  const { locale, reason } = props;

  return (
    <Html lang={locale}>
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{darkTheme}</style>
      </Head>
      <Preview>{props.preview}</Preview>
      <Body
        className="luma-page"
        style={{
          backgroundColor: color.page,
          fontFamily: font,
          margin: 0,
          padding: '32px 0',
        }}
      >
        <Container style={{ maxWidth: '560px', padding: '0 16px' }}>
          <Section style={{ padding: '0 4px 20px' }} data-skip-in-text>
            <Row>
              <Column style={{ width: '28px' }}>
                <div
                  style={{
                    width: '20px',
                    height: '20px',
                    borderRadius: '6px',
                    backgroundColor: color.brand,
                    backgroundImage:
                      'linear-gradient(135deg, #54a3ff 0%, #316bff 100%)',
                  }}
                />
              </Column>
              <Column>
                <Text
                  className="luma-text"
                  style={{
                    margin: 0,
                    fontSize: '17px',
                    fontWeight: 600,
                    letterSpacing: '-0.01em',
                    color: color.text,
                  }}
                >
                  Luma
                </Text>
              </Column>
            </Row>
          </Section>
          <Section
            className="luma-card"
            style={{
              backgroundColor: color.card,
              border: `1px solid ${color.line}`,
              borderRadius: '12px',
              padding: '32px',
            }}
          >
            <Heading
              as="h1"
              className="luma-text"
              style={{
                margin: '0 0 16px',
                fontSize: '22px',
                lineHeight: '30px',
                fontWeight: 600,
                letterSpacing: '-0.01em',
                color: color.text,
              }}
            >
              {props.heading}
            </Heading>
            {props.children}
          </Section>
          <Section style={{ padding: '20px 4px 0' }}>
            <Text
              className="luma-muted"
              style={{
                margin: 0,
                fontSize: '12px',
                lineHeight: '18px',
                color: color.subtle,
              }}
            >
              {reason.kind === 'workspace'
                ? m.email_layout_reason_workspace(
                    { workspace: reason.workspace },
                    { locale },
                  )
                : reason.kind === 'invitation'
                  ? m.email_layout_reason_invitation({}, { locale })
                  : m.email_layout_reason_account({}, { locale })}
            </Text>
            {reason.kind === 'workspace' && reason.preferencesLink ? (
              <Text style={{ margin: '8px 0 0', fontSize: '12px' }}>
                <Link
                  className="luma-link"
                  href={reason.preferencesLink}
                  style={{ color: color.link, textDecoration: 'underline' }}
                >
                  {m.email_layout_preferences({}, { locale })}
                </Link>
              </Text>
            ) : null}
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/** A body paragraph. `tone="muted"` is for secondary notes such as what to do if unexpected. */
export function Paragraph(props: {
  children: ReactNode;
  tone?: 'default' | 'muted';
}) {
  const muted = props.tone === 'muted';

  return (
    <Text
      className={muted ? 'luma-muted' : 'luma-text'}
      style={{
        margin: '0 0 16px',
        fontSize: muted ? '14px' : '15px',
        lineHeight: muted ? '21px' : '24px',
        color: muted ? color.muted : color.text,
      }}
    >
      {props.children}
    </Text>
  );
}

/**
 * The one main action of an email, with the address written out below it for clients that
 * block buttons. The plain-text version shows the address once, after the label.
 */
export function Action(props: {
  locale: Locale;
  href: string;
  children: string;
}) {
  return (
    <Section style={{ margin: '8px 0 16px' }}>
      <Button
        href={props.href}
        style={{
          backgroundColor: color.accent,
          borderRadius: '8px',
          color: '#ffffff',
          fontSize: '15px',
          fontWeight: 600,
          padding: '12px 20px',
          textDecoration: 'none',
        }}
      >
        {props.children}
      </Button>
      <Text
        className="luma-muted"
        data-skip-in-text
        style={{
          margin: '16px 0 0',
          fontSize: '12px',
          lineHeight: '18px',
          color: color.subtle,
        }}
      >
        {m.email_layout_link_fallback({}, { locale: props.locale })}{' '}
        <Link
          className="luma-link"
          href={props.href}
          style={{ color: color.link, wordBreak: 'break-all' }}
        >
          {props.href}
        </Link>
      </Text>
    </Section>
  );
}

/** A secondary link below the main action, such as ending access a notice reports. */
export function SecondaryLink(props: { href: string; children: string }) {
  return (
    <Text style={{ margin: '0 0 16px', fontSize: '14px', lineHeight: '21px' }}>
      <Link
        className="luma-link"
        href={props.href}
        style={{ color: color.link, textDecoration: 'underline' }}
      >
        {props.children}
      </Link>
    </Text>
  );
}

/** Labeled values, such as a workspace and role, in a tinted box; a plain table in text. */
export function Facts(props: { items: { label: string; value: string }[] }) {
  return (
    <Section
      className="luma-tile"
      style={{
        backgroundColor: color.tile,
        borderRadius: '8px',
        padding: '8px 16px',
        margin: '0 0 20px',
      }}
    >
      <table
        role="presentation"
        data-text-format="dataTable"
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        style={{ borderCollapse: 'collapse' }}
      >
        <tbody>
          {props.items.map((item) => (
            <tr key={item.label}>
              <td
                className="luma-muted"
                style={{
                  width: '120px',
                  padding: '4px 12px 4px 0',
                  verticalAlign: 'top',
                  fontSize: '13px',
                  lineHeight: '20px',
                  color: color.subtle,
                }}
              >
                {item.label}
              </td>
              <td
                className="luma-text"
                style={{
                  padding: '4px 0',
                  verticalAlign: 'top',
                  fontSize: '14px',
                  lineHeight: '20px',
                  fontWeight: 600,
                  color: color.text,
                }}
              >
                {item.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

/** Text written by someone else, such as the reason support gave, set apart from Luma's text. */
export function Quote(props: { label: string; children: string }) {
  return (
    <Section
      className="luma-tile"
      style={{
        backgroundColor: color.tile,
        borderLeft: `3px solid ${color.brand}`,
        borderRadius: '4px',
        padding: '12px 16px',
        margin: '0 0 20px',
      }}
    >
      <Text
        className="luma-muted"
        style={{
          margin: '0 0 4px',
          fontSize: '12px',
          lineHeight: '18px',
          fontWeight: 600,
          color: color.subtle,
        }}
      >
        {props.label}
      </Text>
      <Text
        className="luma-text"
        style={{
          margin: 0,
          fontSize: '14px',
          lineHeight: '21px',
          color: color.text,
          whiteSpace: 'pre-line',
        }}
      >
        {props.children}
      </Text>
    </Section>
  );
}
