const crypto = require("crypto");
const { createHeroSmsClient } = require("./herosms-client.cjs");
const heroSMS = createHeroSmsClient();

const COUNTRY_ID = 43;
const SERVICE_CODE = "abk";
const OPERATORS = [
  { code: 'lycamobile', name: 'Lycamobile' },
  { code: 'ortel_mobile', name: 'Ortel Mobile' },
];
const PAYMENT_CODES = new Set(['NO_BALANCE', 'INSUFFICIENT_BALANCE', 'INSUFFICIENT_FUNDS', 'PAYMENT_REQUIRED']);

const firstNames = [
  "Alejandro", "Carlos", "Miguel", "Javier", "Daniel",
  "Pablo", "Antonio", "Jose", "Manuel", "Francisco",
  "David", "Sergio", "Fernando", "Rafael", "Luis",
  "Diego", "Alvaro", "Adrian", "Mario", "Jorge",
  "Pedro", "Raul", "Victor", "Hugo", "Ivan",
  "Marcos", "Andres", "Enrique", "Gabriel", "Roberto",
  "Alberto", "Eduardo", "Ricardo", "Oscar", "Ruben",
  "Santiago", "Nicolas", "Emilio", "Gonzalo", "Ismael",
  "Cristian", "Martin", "Samuel", "Lucas", "Mateo",
  "Bruno", "Hector", "Guillermo", "Ignacio", "Tomas"
];

const lastNames = [
  "Garcia", "Rodriguez", "Gonzalez", "Fernandez", "Lopez",
  "Martinez", "Sanchez", "Perez", "Gomez", "Martin",
  "Jimenez", "Ruiz", "Hernandez", "Diaz", "Moreno",
  "Munoz", "Alvarez", "Romero", "Alonso", "Gutierrez",
  "Navarro", "Torres", "Dominguez", "Vazquez", "Ramos",
  "Gil", "Ramirez", "Serrano", "Blanco", "Molina",
  "Morales", "Suarez", "Ortega", "Delgado", "Castro",
  "Ortiz", "Rubio", "Marin", "Sanz", "Iglesias",
  "Medina", "Garrido", "Cortes", "Castillo", "Santos",
  "Lozano", "Guerrero", "Cano", "Prieto", "Mendez"
];

const addresses = [
  { city: "Berlin", zip: "10115", street: "Brunnenstrasse" },
  { city: "Hamburg", zip: "20095", street: "Bergstrasse" },
  { city: "Munich", zip: "80331", street: "Sendlinger Strasse" },
  { city: "Cologne", zip: "50667", street: "Breite Strasse" },
  { city: "Frankfurt am Main", zip: "60311", street: "Bleichstrasse" },
  { city: "Stuttgart", zip: "70173", street: "Koenigstrasse" },
  { city: "Duesseldorf", zip: "40213", street: "Wallstrasse" },
  { city: "Leipzig", zip: "04109", street: "Bruehl" },
  { city: "Dortmund", zip: "44135", street: "Hohe Strasse" },
  { city: "Essen", zip: "45127", street: "Limbecker Strasse" },
  { city: "Bremen", zip: "28195", street: "Soegestrasse" },
  { city: "Dresden", zip: "01067", street: "Prager Strasse" },
  { city: "Hanover", zip: "30159", street: "Lister Meile" },
  { city: "Nuremberg", zip: "90402", street: "Ludwigsplatz" },
  { city: "Duisburg", zip: "47051", street: "Mercatorstrasse" },
  { city: "Bochum", zip: "44787", street: "Massenbergstrasse" },
  { city: "Wuppertal", zip: "42103", street: "Friedrich-Engels-Allee" },
  { city: "Bielefeld", zip: "33602", street: "Ritterstrasse" },
  { city: "Bonn", zip: "53111", street: "Wenzelgasse" },
  { city: "Muenster", zip: "48143", street: "Salzstrasse" },
  { city: "Karlsruhe", zip: "76133", street: "Waldstrasse" },
  { city: "Mannheim", zip: "68159", street: "Rheinstrasse" },
  { city: "Augsburg", zip: "86150", street: "Annabergstrasse" },
  { city: "Wiesbaden", zip: "65183", street: "Langgasse" },
  { city: "Gelsenkirchen", zip: "45879", street: "Hauptstrasse" },
  { city: "Moenchengladbach", zip: "41061", street: "Bismarckstrasse" },
  { city: "Braunschweig", zip: "38100", street: "Hagenbruecke" },
  { city: "Chemnitz", zip: "09111", street: "Innere Klosterstrasse" },
  { city: "Kiel", zip: "24103", street: "Daenische Strasse" },
  { city: "Aachen", zip: "52062", street: "Pontstrasse" },
  { city: "Halle", zip: "06108", street: "Grosse Steintrasse" },
  { city: "Magdeburg", zip: "39104", street: "Hasselbachstrasse" },
  { city: "Freiburg", zip: "79098", street: "Bertoldstrasse" },
  { city: "Krefeld", zip: "47798", street: "Friedrichstrasse" },
  { city: "Luebeck", zip: "23552", street: "Fleischhauerstrasse" },
  { city: "Oberhausen", zip: "46045", street: "Friedrich-Karl-Strasse" },
  { city: "Erfurt", zip: "99084", street: "Johannesstrasse" },
  { city: "Mainz", zip: "55116", street: "Grosse Bleiche" },
  { city: "Rostock", zip: "18055", street: "Breite Strasse" },
  { city: "Kassel", zip: "34117", street: "Treppenstrasse" },
  { city: "Hagen", zip: "58095", street: "Kampstrasse" },
  { city: "Potsdam", zip: "14467", street: "Friedrich-Ebert-Strasse" },
  { city: "Saarbruecken", zip: "66111", street: "Kaiserstrasse" },
  { city: "Hamm", zip: "59065", street: "Bahnhofstrasse" },
  { city: "Ludwigshafen", zip: "67059", street: "Bismarckstrasse" },
  { city: "Oldenburg", zip: "26122", street: "Achternstrasse" },
  { city: "Osnabrueck", zip: "49074", street: "Krahnstrasse" },
  { city: "Leverkusen", zip: "51373", street: "Duesseldorfer Strasse" },
  { city: "Heidelberg", zip: "69117", street: "Hauptstrasse" },
  { city: "Darmstadt", zip: "64283", street: "Schulstrasse" }
];

function randomItem(array) {
  return array[crypto.randomInt(array.length)];
}

function randomNumber(min, max) {
  return crypto.randomInt(min, max + 1);
}

function generateBirthday() {
  const today = new Date();

  const latest = new Date(today);
  latest.setFullYear(latest.getFullYear() - 18);

  const earliest = new Date(today);
  earliest.setFullYear(earliest.getFullYear() - 61);
  earliest.setDate(earliest.getDate() + 1);

  const timestamp = randomNumber(
    earliest.getTime(),
    latest.getTime()
  );

  const date = new Date(timestamp);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function generatePassword(length = 14) {
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const numbers = "0123456789";
  const symbols = "!@#$%&*";

  const all = uppercase + lowercase + numbers + symbols;

  const chars = [
    randomItem([...uppercase]),
    randomItem([...lowercase]),
    randomItem([...numbers]),
    randomItem([...symbols])
  ];

  while (chars.length < length) {
    chars.push(randomItem([...all]));
  }

  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}

function generateGender() {
  return randomItem(["Male", "Female", "Diverse"]);
}

async function getGermanNumber({ signal } = {}) {
  let paymentRejected = false;
  for (const operator of OPERATORS) {
    signal?.throwIfAborted();
    let result;
    try {
      result = await heroSMS('getNumberV2', { country: COUNTRY_ID, service: SERVICE_CODE, operator: operator.code }, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (error.httpStatus === 402 || PAYMENT_CODES.has(error.providerCode)) { paymentRejected = true; continue; }
      if (error.providerCode === 'NO_NUMBERS') continue;
      throw error;
    }
    const responseCode = typeof result === 'string' ? result : result?.code || result?.errorCode || result?.error;
    if (responseCode === 'NO_NUMBERS') continue;
    if (PAYMENT_CODES.has(responseCode)) { paymentRejected = true; continue; }
    if (!result || typeof result !== 'object' || !result.phoneNumber || !result.activationId) {
      throw Object.assign(new Error(`HeroSMS did not return a valid ${operator.name} number for GMX.`), { code: /^[A-Z_]+$/.test(responseCode || '') ? responseCode : 'PHONE_ACTIVATION_INVALID' });
    }
    console.log(`[HeroSMS] German ${operator.name} number acquired for GMX.`);
    return {
      phoneNumber: `+${String(result.phoneNumber).replace(/^\+/, '')}`,
      activationId: String(result.activationId),
      service: 'GMX', serviceCode: SERVICE_CODE,
      country: 'Germany', countryId: COUNTRY_ID,
      operator: operator.name, operatorCode: operator.code,
      price: result.activationCost ?? null,
      currency: result.currency ?? null,
      activationTime: result.activationTime ?? null,
      activationEndTime: result.activationEndTime ?? null,
      canGetAnotherSms: result.canGetAnotherSms,
    };
  }
  if (paymentRejected) throw Object.assign(new Error('HeroSMS rejected payment for the available Lycamobile / Ortel Mobile numbers (HTTP_402 / NO_BALANCE). Check your balance and operator pricing in HeroSMS.'), { code: 'HEROSMS_PAYMENT_REQUIRED' });
  throw new Error('No German Lycamobile or Ortel Mobile numbers are currently available for GMX on HeroSMS. Try again later.');
}

async function getSMS(activationId, { signal } = {}) {
  if (!activationId) {
    throw new Error("Activation ID is required");
  }

  const result = await heroSMS("getStatus", {
    id: activationId
  }, { signal });

  const response = String(result);

  if (response.startsWith("STATUS_OK:")) {
    return {
      activationId: String(activationId),
      status: "RECEIVED",
      otp: response.slice("STATUS_OK:".length),
      rawStatus: response
    };
  }

  if (
    response === "STATUS_WAIT_CODE" ||
    response === "STATUS_WAIT_RETRY" || response.startsWith("STATUS_WAIT_RETRY:") ||
    response === "STATUS_WAIT_RESEND"
  ) {
    return {
      activationId: String(activationId),
      status: "WAITING",
      otp: null,
      rawStatus: response
    };
  }

  if (response === "STATUS_CANCEL") {
    return {
      activationId: String(activationId),
      status: "CANCELLED",
      otp: null,
      rawStatus: response
    };
  }

  return {
    activationId: String(activationId),
    status: "UNKNOWN",
    otp: null,
    rawStatus: response
  };
}

async function requestNextSms(activationId, { signal } = {}) {
  const result = await heroSMS('setStatus', { id: activationId, status: 3 }, { signal });
  if (result !== 'ACCESS_RETRY_GET') {
    throw Object.assign(new Error('HeroSMS did not confirm that the activation can receive another SMS.'), { code: typeof result === 'string' && /^[A-Z_]+$/.test(result) ? result : 'SMS_RESET_FAILED' });
  }
}

async function checkSmsProvider({ signal } = {}) {
  const result = await heroSMS('getBalance', {}, { signal });
  const balance = typeof result === 'string' && result.startsWith('ACCESS_BALANCE:') ? Number(result.slice(15)) : Number(result?.balance);
  if (!Number.isFinite(balance) || balance <= 0) {
    throw Object.assign(new Error('HeroSMS is unavailable or has insufficient balance.'), {
      code: balance <= 0 ? 'NO_BALANCE' : typeof result === 'string' && /^[A-Z_]+$/.test(result) ? result : 'SMS_PROVIDER_UNAVAILABLE',
    });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForSMS(
  activationId,
  timeoutMs = 360000,
  intervalMs = 5000
) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const sms = await getSMS(activationId);

    if (sms.status === "RECEIVED") {
      return sms;
    }

    if (sms.status === "CANCELLED") {
      return sms;
    }

    if (sms.status === "UNKNOWN") {
      throw new Error(
        `Unexpected SMS status: ${sms.rawStatus}`
      );
    }

    await sleep(intervalMs);
  }

  return {
    activationId: String(activationId),
    status: "TIMEOUT",
    otp: null
  };
}

function generateProfile() {
  const firstName = randomItem(firstNames);
  const lastName = randomItem(lastNames);
  const address = randomItem(addresses);
  const houseNumber = randomNumber(1, 150);
  const password = generatePassword();

  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,

    birthday: generateBirthday(),

    address: {
      street: `${address.street} ${houseNumber}`,
      city: address.city,
      zipCode: address.zip,
      country: "Germany"
    },

    password,
    confirmPassword: password,

    gender: generateGender(),
  };
}

async function generatePerson() {
  const profile = generateProfile();
  const heroNumber = await getGermanNumber();
  return {
    ...profile,
    phone: heroNumber.phoneNumber,
    heroSMS: {
      activationId: heroNumber.activationId,
      service: heroNumber.service,
      operator: heroNumber.operator,
      operatorCode: heroNumber.operatorCode,
      price: heroNumber.price,
      currency: heroNumber.currency,
      activationTime: heroNumber.activationTime,
      activationEndTime: heroNumber.activationEndTime
    }
  };
}

async function main() {
  const command = process.argv[2] || "generate";
  const activationId = process.argv[3];

  switch (command) {
    case "generate": {
      const person = await generatePerson();

      console.log(JSON.stringify(person, null, 2));
      break;
    }

    case "sms": {
      if (!activationId) {
        throw new Error(
          "Usage: node generator.js sms ACTIVATION_ID"
        );
      }

      const result = await getSMS(activationId);

      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case "wait": {
      if (!activationId) {
        throw new Error(
          "Usage: node generator.js wait ACTIVATION_ID"
        );
      }

      const result = await waitForSMS(activationId);

      console.log(JSON.stringify(result, null, 2));
      break;
    }

    default:
      throw new Error(
        `Unknown command: ${command}\n` +
        "Available commands: generate, sms, wait"
      );
  }
}

module.exports = {
  generateProfile,
  generatePerson,
  getGermanNumber,
  getSMS,
  requestNextSms,
  checkSmsProvider,
  waitForSMS,
  heroSMS
};

if (require.main === module) {
  main().catch(error => {
    console.error(
      JSON.stringify({
        success: false,
        error: error.message
      }, null, 2)
    );

    process.exitCode = 1;
  });
}