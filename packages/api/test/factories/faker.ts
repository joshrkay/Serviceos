function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomString(length: number, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
  return Array.from({ length }, () => alphabet[randomInt(0, alphabet.length - 1)]).join('');
}

function randomFrom<T>(values: T[]): T {
  return values[randomInt(0, values.length - 1)];
}

function randomWords(minWords = 3, maxWords = 8): string {
  const words = ['service', 'repair', 'install', 'inspect', 'replace', 'diagnostic', 'urgent', 'customer', 'system', 'unit', 'line', 'maintenance'];
  const count = randomInt(minWords, maxWords);
  return Array.from({ length: count }, () => randomFrom(words)).join(' ');
}

function recentDate(): Date {
  return new Date(Date.now() - randomInt(0, 7 * 24 * 60 * 60 * 1000));
}

function futureDate(): Date {
  return new Date(Date.now() + randomInt(1, 365) * 24 * 60 * 60 * 1000);
}

function buildUuidV4Like(): string {
  const hex = '0123456789abcdef';
  const section = (len: number) => randomString(len, hex);
  return `${section(8)}-${section(4)}-4${section(3)}-${randomFrom(['8', '9', 'a', 'b'])}${section(3)}-${section(12)}`;
}

export const faker = {
  string: {
    uuid: () => buildUuidV4Like(),
    numeric: (length: number) => randomString(length, '0123456789'),
    alphanumeric: (length: number) => randomString(length),
  },
  person: {
    firstName: () => randomFrom(['Alex', 'Jordan', 'Taylor', 'Sam', 'Casey', 'Jamie']),
    lastName: () => randomFrom(['Smith', 'Johnson', 'Lee', 'Brown', 'Davis', 'Wilson']),
    fullName: () => `${faker.person.firstName()} ${faker.person.lastName()}`,
  },
  company: {
    name: () => `${randomFrom(['North', 'Metro', 'Summit', 'Evergreen', 'Premier'])} ${randomFrom(['Mechanical', 'Services', 'Solutions', 'Contracting'])}`,
  },
  phone: {
    number: () => `(${randomInt(200, 999)}) ${randomInt(100, 999)}-${randomInt(1000, 9999)}`,
  },
  internet: {
    email: () => `${randomString(8)}@example.com`,
  },
  lorem: {
    sentence: (_opts?: { min?: number; max?: number }) => `${randomWords(4, 10)}.`,
    paragraph: () => `${randomWords(30, 45)}.`,
  },
  date: {
    recent: () => recentDate(),
    future: () => futureDate(),
  },
  helpers: {
    arrayElement: <T>(values: T[]) => randomFrom(values),
  },
  number: {
    int: ({ min, max }: { min: number; max: number }) => randomInt(min, max),
    float: ({
      min,
      max,
      fractionDigits = 2,
    }: {
      min: number;
      max: number;
      fractionDigits?: number;
    }) => Number((Math.random() * (max - min) + min).toFixed(fractionDigits)),
  },
  location: {
    secondaryAddress: () => `Suite ${randomInt(100, 999)}`,
    streetAddress: () => `${randomInt(100, 9999)} ${randomFrom(['Main', 'Oak', 'Pine', 'Maple'])} St`,
    city: () => randomFrom(['Springfield', 'Riverton', 'Lakeview', 'Fairview']),
    state: ({ abbreviated }: { abbreviated?: boolean } = {}) =>
      abbreviated ? randomFrom(['CA', 'TX', 'FL', 'NY']) : randomFrom(['California', 'Texas', 'Florida', 'New York']),
    zipCode: () => faker.string.numeric(5),
    latitude: () => Number((Math.random() * 180 - 90).toFixed(6)),
    longitude: () => Number((Math.random() * 360 - 180).toFixed(6)),
  },
  commerce: {
    productName: () => `${randomFrom(['Premium', 'Standard', 'Heavy-Duty'])} ${randomFrom(['Compressor', 'Valve', 'Filter', 'Pipe'])}`,
  },
};
