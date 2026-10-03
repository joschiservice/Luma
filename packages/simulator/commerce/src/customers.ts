import { createRandom } from '@luma/simulator-core';

const firstNames = [
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
const lastNames = [
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
};
const streets = [
  'Hauptstraße',
  'Bahnhofstraße',
  'Gartenweg',
  'Seestraße',
  'Lindenallee',
];

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
  const firstName = random.pick(firstNames);
  const lastName = random.pick(lastNames);
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
    phone: `+49 151 ${String(1_000_000 + number).slice(-7)}`,
    address: {
      address1: `${random.pick(streets)} ${random.int(1, 120)}`,
      city,
      zip,
      countryCode: country,
    },
  };
}
