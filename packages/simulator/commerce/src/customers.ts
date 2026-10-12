import { createRandom } from '@luma/simulator-core';

const germanFirstNames = [
  'Anna',
  'Lukas',
  'Mia',
  'Leon',
  'Emma',
  'Felix',
  'Lena',
  'Jonas',
  'Laura',
  'Paul',
  'Sophie',
  'Elias',
  'Marie',
  'Noah',
  'Clara',
  'Luca',
  'Hannah',
  'Matteo',
  'Lea',
  'David',
  'Nina',
  'Samuel',
  'Julia',
  'Tim',
];
const germanLastNames = [
  'Müller',
  'Schmidt',
  'Schneider',
  'Fischer',
  'Weber',
  'Meyer',
  'Wagner',
  'Becker',
  'Hoffmann',
  'Schulz',
  'Gruber',
  'Huber',
  'Bauer',
  'Steiner',
  'Keller',
  'Brunner',
  'Frei',
  'Graf',
  'Moser',
  'Wolf',
];
const englishFirstNames = [
  'Olivia',
  'Jack',
  'Charlotte',
  'Oliver',
  'Amelia',
  'Noah',
  'Isla',
  'William',
  'Mia',
  'Lucas',
  'Ava',
  'Henry',
  'Grace',
  'Leo',
  'Chloe',
  'James',
  'Ruby',
  'Thomas',
  'Emily',
  'Ethan',
  'Zoe',
  'Harrison',
  'Aria',
  'Mason',
];
const englishLastNames = [
  'Smith',
  'Jones',
  'Williams',
  'Brown',
  'Wilson',
  'Taylor',
  'Nguyen',
  'Johnson',
  'Martin',
  'White',
  'Anderson',
  'Walker',
  'Thompson',
  'Patel',
  'Singh',
  'Clarke',
  'Ngata',
  'Davies',
  'Garcia',
  'Miller',
];
const cities: Record<string, [string, string][]> = {
  DE: [
    ['Berlin', '10115'],
    ['Hamburg', '20095'],
    ['München', '80331'],
    ['Köln', '50667'],
    ['Leipzig', '04109'],
  ],
  AT: [
    ['Wien', '1010'],
    ['Graz', '8010'],
    ['Linz', '4020'],
    ['Salzburg', '5020'],
  ],
  CH: [
    ['Zürich', '8001'],
    ['Basel', '4051'],
    ['Bern', '3011'],
    ['Luzern', '6003'],
  ],
  AU: [
    ['Sydney NSW', '2000'],
    ['Melbourne VIC', '3000'],
    ['Brisbane QLD', '4000'],
    ['Perth WA', '6000'],
    ['Adelaide SA', '5000'],
    ['Hobart TAS', '7000'],
  ],
  NZ: [
    ['Auckland', '1010'],
    ['Wellington', '6011'],
    ['Christchurch', '8011'],
    ['Hamilton', '3204'],
    ['Dunedin', '9016'],
  ],
  GB: [
    ['London', 'EC1A 1BB'],
    ['Manchester', 'M1 1AE'],
    ['Leeds', 'LS1 4AP'],
    ['Bristol', 'BS1 4DJ'],
    ['Edinburgh', 'EH1 1YZ'],
    ['Kendal', 'LA9 4DL'],
  ],
  US: [
    ['Denver, CO', '80202'],
    ['Seattle, WA', '98101'],
    ['Portland, OR', '97204'],
    ['Austin, TX', '78701'],
    ['Brooklyn, NY', '11201'],
    ['Boulder, CO', '80302'],
  ],
};
const germanStreets = [
  'Hauptstraße',
  'Bahnhofstraße',
  'Gartenweg',
  'Seestraße',
  'Lindenallee',
];
const englishStreets: Record<string, string[]> = {
  AU: ['George Street', 'Smith Street', 'Beach Road', 'King Street'],
  NZ: ['Queen Street', 'Ponsonby Road', 'Cuba Street', 'Colombo Street'],
  GB: ['High Street', 'Station Road', 'Church Lane', 'Mill Road'],
  US: ['Main Street', 'Oak Avenue', 'Pine Street', 'Maple Drive'],
};
// Mobile number prefixes by country; other countries use a German mobile number.
const phonePrefixes: Record<string, string> = {
  AU: '+61 412',
  NZ: '+64 21',
  GB: '+44 7700',
  US: '+1 303',
};
const businessKinds: Record<string, string[]> = {
  de: ['Drogerie', 'Apotheke', 'Concept Store', 'Naturkostladen', 'Parfümerie'],
  en: ['Homewares', 'Boutique', 'General Store', 'Gift Shop', 'Interiors'],
};
const businessSuffix: Record<string, string> = {
  AU: 'Pty Ltd',
  NZ: 'Ltd',
  GB: 'Ltd',
  US: 'LLC',
  DE: 'GmbH',
  AT: 'GmbH',
  CH: 'AG',
};

/** German-speaking countries; their customers have German names and addresses. */
export const germanSpeaking = (country: string) =>
  ['DE', 'AT', 'CH'].includes(country);

/** A synthetic customer identity; names and addresses are fictional. */
export interface SyntheticCustomer {
  number: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address: {
    address1: string;
    city: string;
    zip: string;
    countryCode: string;
  };
}

/** Derives the customer with the given number in a shop; the same inputs give the same person. */
export function customer(
  seed: number,
  shop: string,
  country: string,
  number: number,
): SyntheticCustomer {
  const random = createRandom(`${seed}:${shop}:customer:${number}`);
  const german = germanSpeaking(country) || !cities[country];
  const firstName = random.pick(german ? germanFirstNames : englishFirstNames);
  const lastName = random.pick(german ? germanLastNames : englishLastNames);
  const [city, zip] = random.pick(cities[country] ?? cities.DE!);

  return {
    number,
    firstName,
    lastName,
    email: `${firstName}.${lastName}.${number}@customer.example`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss'),
    phone: `${phonePrefixes[country] ?? '+49 151'} ${String(1_000_000 + number).slice(-7)}`,
    address: {
      address1: german
        ? `${random.pick(germanStreets)} ${random.int(1, 120)}`
        : `${random.int(1, 120)} ${random.pick(englishStreets[country]!)}`,
      city,
      zip,
      countryCode: country,
    },
  };
}

/**
 * Derives the business account with the given number, such as a retailer that orders
 * wholesale; the same inputs give the same account. Its contact person orders for the company.
 */
export function businessCustomer(
  seed: number,
  country: string,
  number: number,
): SyntheticCustomer & { company: string } {
  const person = customer(seed, 'wholesale', country, number);
  const random = createRandom(`${seed}:wholesale:account:${number}`);
  const kind = random.pick(
    businessKinds[germanSpeaking(country) ? 'de' : 'en']!,
  );
  const town = person.address.city.replace(/,? [A-Z]{2,3}$/, '');
  const suffix = businessSuffix[country] ?? 'Ltd';

  return {
    ...person,
    company: `${person.lastName} ${kind} ${town} ${suffix}`,
    email: `orders.${number}@retailer.example`,
  };
}
