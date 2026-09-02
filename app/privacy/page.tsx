/**
 * /privacy — public privacy statement for Claudable (no sign-in required; the
 * edge proxy lists it as public). Google's OAuth consent screen links here, so
 * this page must stay reachable and describe what the portal actually does
 * with personal data. Dutch first (the portal's audience), English below.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacyverklaring · Claudable',
  description: 'Hoe Claudable, het bouwportaal van New Story, met persoonsgegevens omgaat.',
  robots: { index: true, follow: true },
};

const EFFECTIVE = '2 september 2026';
const EFFECTIVE_EN = '2 September 2026';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-50">{title}</h2>
      <div className="space-y-2 text-[15px] leading-relaxed text-gray-700 dark:text-gray-300">{children}</div>
    </section>
  );
}

function Table({ rows }: { rows: [string, string, string][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <tbody>
          {rows.map(([a, b, c]) => (
            <tr key={a} className="border-t border-gray-200 dark:border-white/10 align-top">
              <td className="py-2 pr-3 font-medium text-gray-900 dark:text-gray-50 whitespace-nowrap">{a}</td>
              <td className="py-2 pr-3 text-gray-700 dark:text-gray-300">{b}</td>
              <td className="py-2 text-gray-500 dark:text-gray-400">{c}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white dark:bg-[#0f1311] text-gray-900 dark:text-gray-50">
      <div className="mx-auto max-w-2xl px-6 py-14 space-y-12">
        <header className="space-y-3">
          <Link href="/" className="text-sm text-brand-600 dark:text-brand-400 hover:underline">← Claudable</Link>
          <h1 className="text-3xl font-semibold tracking-tight">Privacyverklaring</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Claudable · ingangsdatum {EFFECTIVE} · <a href="#english" className="underline">English version below</a>
          </p>
        </header>

        {/* ---------------------------------------------------------------- NL */}
        <div className="space-y-8">
          <Section title="1. Wie zijn wij">
            <p>
              Claudable (claudable.newstory.tf) is het bouwportaal van <strong>New Story</strong>, Erasmusweg 19,
              2202 CA Noordwijk, Nederland. New Story is verwerkingsverantwoordelijke voor de persoonsgegevens die
              in Claudable worden verwerkt. Vragen over privacy: <a className="underline" href="mailto:support@newstory.tf">support@newstory.tf</a>.
            </p>
          </Section>

          <Section title="2. Wat Claudable doet">
            <p>
              In Claudable bouwen medewerkers van New Story en uitgenodigde klanten websites en applicaties met hulp van
              een AI-assistent. Toegang is <strong>alleen op uitnodiging</strong>: je logt in met een Google-account dat door
              een beheerder van jouw organisatie is uitgenodigd. Je ziet uitsluitend de projecten en leden van je eigen organisatie.
            </p>
          </Section>

          <Section title="3. Welke gegevens wij verwerken">
            <Table rows={[
              ['Account', 'Naam, e-mailadres en profielfoto van je Google-account; taalvoorkeur; organisatie en rol.', 'Nodig om je te laten inloggen en te bepalen wat je mag zien (uitvoering overeenkomst / gerechtvaardigd belang).'],
              ['Uitnodigingen', 'E-mailadres, uitgenodigde rol, wie je heeft uitgenodigd, vervaldatum.', 'Nodig om alleen uitgenodigde personen toegang te geven.'],
              ['Projectinhoud', 'Opdrachten (prompts) die je aan de AI-assistent geeft, gegenereerde code en bestanden, chatgeschiedenis, uploads, omgevingsvariabelen van je project.', 'Dit is de kern van de dienst.'],
              ['Reacties', 'Opmerkingen die je bij een project plaatst en @-vermeldingen van collega’s.', 'Samenwerking binnen je organisatie.'],
              ['Logboek', 'Beheeracties (lid toegevoegd of verwijderd, rol gewijzigd, uitnodiging, zichtbaarheid van een project) met tijdstip en wie de actie deed.', 'Beveiliging en verantwoording binnen je organisatie.'],
              ['Technisch', 'Sessiecookie, IP-adres en tijdstip in serverlogboeken, foutmeldingen uit de voorbeeldweergave van je project.', 'Beveiliging, misbruikpreventie en het oplossen van storingen.'],
            ]} />
            <p>
              Claudable gebruikt <strong>geen</strong> trackingcookies of advertentiecookies. De enige cookie is de
              sessiecookie waarmee je ingelogd blijft.
            </p>
          </Section>

          <Section title="4. Met wie wij gegevens delen">
            <p>Wij verkopen geen gegevens. Wij schakelen de volgende verwerkers in, elk onder een verwerkersovereenkomst:</p>
            <Table rows={[
              ['Google', 'Inloggen met je Google-account (OAuth). Google ontvangt daarbij dat je inlogt bij Claudable.', 'VS / EU · Google Ireland Ltd.'],
              ['Anthropic', 'De AI-assistent. Je opdrachten, de projectbestanden die daarvoor nodig zijn en de chatgeschiedenis van een project worden naar Anthropic gestuurd om code te genereren. Anthropic gebruikt deze gegevens niet om modellen te trainen.', 'VS · onder EU-modelcontractbepalingen.'],
              ['Amazon Web Services', 'Hosting van Claudable en opslag van projecten.', 'EU · regio Frankfurt (eu-central-1).'],
              ['Mailgun (Sinch)', 'Verzenden van uitnodigingen en meldingen per e-mail.', 'EU · EU-regio.'],
              ['GitHub / Gitea', 'Opslag van broncode wanneer een project wordt gepubliceerd. GitHub alleen als jouw organisatie daarvoor kiest.', 'VS (GitHub) / EU (Gitea, eigen beheer New Story).'],
              ['Vercel, Supabase', 'Alleen als jouw project deze diensten koppelt voor hosting of een database.', 'VS / EU, afhankelijk van instelling.'],
            ]} />
          </Section>

          <Section title="5. Hoe lang wij gegevens bewaren">
            <ul className="list-disc pl-5 space-y-1">
              <li>Account- en organisatiegegevens: zolang je lid bent van een organisatie in Claudable. Na verwijdering uit je laatste organisatie kun je niet meer inloggen; het account wordt binnen 90 dagen verwijderd tenzij je opnieuw wordt uitgenodigd.</li>
              <li>Uitnodigingen: 14 dagen geldig; daarna verlopen en na 90 dagen verwijderd.</li>
              <li>Projectinhoud: zolang het project bestaat. Verwijdert je organisatie een project, dan worden de bestanden en de chatgeschiedenis verwijderd.</li>
              <li>Logboek van beheeracties: 24 maanden.</li>
              <li>Serverlogboeken: 30 dagen.</li>
            </ul>
          </Section>

          <Section title="6. Beveiliging">
            <p>
              Alle verkeer verloopt versleuteld (TLS). Toegang is per organisatie afgeschermd en alleen mogelijk na
              uitnodiging; beheerders van New Story kunnen bij alle organisaties voor ondersteuning en beheer.
              Wachtwoorden bewaren wij niet: authenticatie loopt volledig via Google.
            </p>
          </Section>

          <Section title="7. Jouw rechten">
            <p>
              Je hebt recht op inzage, correctie, verwijdering, beperking en overdraagbaarheid van je gegevens en je kunt
              bezwaar maken tegen verwerking. Mail naar <a className="underline" href="mailto:support@newstory.tf">support@newstory.tf</a>;
              wij reageren binnen een maand. Je kunt ook een klacht indienen bij de Autoriteit Persoonsgegevens.
            </p>
          </Section>

          <Section title="8. Wijzigingen">
            <p>
              Wij kunnen deze verklaring aanpassen. De actuele versie staat altijd op deze pagina, met de ingangsdatum bovenaan.
              Bij ingrijpende wijzigingen informeren wij de beheerders van de organisaties in Claudable per e-mail.
            </p>
          </Section>
        </div>

        {/* ---------------------------------------------------------------- EN */}
        <div id="english" className="space-y-8 border-t border-gray-200 dark:border-white/10 pt-10">
          <header className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">Privacy statement</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">Claudable · effective {EFFECTIVE_EN}</p>
          </header>

          <Section title="1. Who we are">
            <p>
              Claudable (claudable.newstory.tf) is the build portal of <strong>New Story</strong>, Erasmusweg 19,
              2202 CA Noordwijk, the Netherlands. New Story is the data controller for personal data processed in Claudable.
              Privacy questions: <a className="underline" href="mailto:support@newstory.tf">support@newstory.tf</a>.
            </p>
          </Section>

          <Section title="2. What Claudable does">
            <p>
              In Claudable, New Story staff and invited customers build websites and applications with the help of an AI
              assistant. Access is <strong>by invitation only</strong>: you sign in with a Google account that an administrator
              of your organisation has invited. You only see the projects and members of your own organisation.
            </p>
          </Section>

          <Section title="3. What data we process">
            <Table rows={[
              ['Account', 'Name, e-mail address and profile picture from your Google account; language preference; organisation and role.', 'Needed to sign you in and decide what you may see (contract / legitimate interest).'],
              ['Invitations', 'E-mail address, invited role, who invited you, expiry date.', 'Needed to admit only invited people.'],
              ['Project content', 'Prompts you give the AI assistant, generated code and files, chat history, uploads, your project’s environment variables.', 'This is the core of the service.'],
              ['Comments', 'Comments you leave on a project and @-mentions of colleagues.', 'Collaboration within your organisation.'],
              ['Audit log', 'Administrative actions (member added or removed, role changed, invitation, project visibility) with timestamp and actor.', 'Security and accountability within your organisation.'],
              ['Technical', 'Session cookie, IP address and timestamp in server logs, error output from your project’s preview.', 'Security, abuse prevention and troubleshooting.'],
            ]} />
            <p>Claudable sets <strong>no</strong> tracking or advertising cookies. The only cookie is the session cookie that keeps you signed in.</p>
          </Section>

          <Section title="4. Who we share data with">
            <p>We do not sell data. We use the following processors, each under a data-processing agreement:</p>
            <Table rows={[
              ['Google', 'Sign-in with your Google account (OAuth). Google learns that you sign in to Claudable.', 'US / EU · Google Ireland Ltd.'],
              ['Anthropic', 'The AI assistant. Your prompts, the project files needed for them and a project’s chat history are sent to Anthropic to generate code. Anthropic does not use this data to train models.', 'US · under EU standard contractual clauses.'],
              ['Amazon Web Services', 'Hosting of Claudable and storage of projects.', 'EU · Frankfurt region (eu-central-1).'],
              ['Mailgun (Sinch)', 'Sending invitations and notifications by e-mail.', 'EU · EU region.'],
              ['GitHub / Gitea', 'Source-code storage when a project is published. GitHub only if your organisation chooses it.', 'US (GitHub) / EU (Gitea, operated by New Story).'],
              ['Vercel, Supabase', 'Only if your project connects these services for hosting or a database.', 'US / EU, depending on configuration.'],
            ]} />
          </Section>

          <Section title="5. How long we keep data">
            <ul className="list-disc pl-5 space-y-1">
              <li>Account and organisation data: as long as you are a member of an organisation in Claudable. After removal from your last organisation you can no longer sign in; the account is deleted within 90 days unless you are re-invited.</li>
              <li>Invitations: valid for 14 days; expired invitations are deleted after 90 days.</li>
              <li>Project content: as long as the project exists. When your organisation deletes a project, its files and chat history are deleted.</li>
              <li>Audit log: 24 months.</li>
              <li>Server logs: 30 days.</li>
            </ul>
          </Section>

          <Section title="6. Security">
            <p>
              All traffic is encrypted (TLS). Access is segregated per organisation and possible only after an invitation;
              New Story administrators can reach all organisations for support and operations. We store no passwords:
              authentication is handled entirely by Google.
            </p>
          </Section>

          <Section title="7. Your rights">
            <p>
              You have the right to access, rectify, erase, restrict and port your data, and to object to processing. E-mail
              <a className="underline" href="mailto:support@newstory.tf"> support@newstory.tf</a>; we respond within one month.
              You may also lodge a complaint with the Dutch Data Protection Authority (Autoriteit Persoonsgegevens).
            </p>
          </Section>

          <Section title="8. Changes">
            <p>
              We may update this statement. The current version is always on this page, with its effective date at the top.
              For material changes we notify the administrators of the organisations in Claudable by e-mail.
            </p>
          </Section>
        </div>

        <footer className="text-xs text-gray-500 dark:text-gray-400 border-t border-gray-200 dark:border-white/10 pt-6">
          New Story · Erasmusweg 19, 2202 CA Noordwijk · <a className="underline" href="https://www.newstory.nl">newstory.nl</a>
        </footer>
      </div>
    </main>
  );
}
