const crypto = require("crypto");
const { createHeroSmsClient } = require("./herosms-client.cjs");
const heroSMS = createHeroSmsClient();

const COUNTRY_ID = 43; // Germany
const SERVICE_CODE = "abk"; // GMX
const OPERATORS = [
  { code: 'lycamobile', name: 'Lycamobile' },
  { code: 'ortel_mobile', name: 'Ortel Mobile' },
];
const PAYMENT_CODES = new Set(['NO_BALANCE', 'INSUFFICIENT_BALANCE', 'INSUFFICIENT_FUNDS', 'PAYMENT_REQUIRED']);

// ==========================================
// 50 SPANISH FIRST NAMES
// ==========================================

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

// ==========================================
// 50 SPANISH LAST NAMES
// ==========================================

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

// ==========================================
// 50 GERMAN ADDRESS TEMPLATES
// Synthetic test addresses, not verified
// residential or delivery addresses.
// ==========================================

const addresses = [
  { city: "Berlin", zip: "10115", street: "Musterstrasse" },
  { city: "Hamburg", zip: "20095", street: "Beispielweg" },
  { city: "Munich", zip: "80331", street: "Teststrasse" },
  { city: "Cologne", zip: "50667", street: "Musterweg" },
  { city: "Frankfurt", zip: "60311", street: "Beispielstrasse" },
  { city: "Stuttgart", zip: "70173", street: "Testweg" },
  { city: "Dusseldorf", zip: "40213", street: "Demostrasse" },
  { city: "Leipzig", zip: "04109", street: "Musterallee" },
  { city: "Dortmund", zip: "44135", street: "Beispielallee" },
  { city: "Essen", zip: "45127", street: "Testallee" },

  { city: "Bremen", zip: "28195", street: "Musterplatz" },
  { city: "Dresden", zip: "01067", street: "Beispielplatz" },
  { city: "Hanover", zip: "30159", street: "Testplatz" },
  { city: "Nuremberg", zip: "90402", street: "Demoweg" },
  { city: "Duisburg", zip: "47051", street: "Musterpfad" },
  { city: "Bochum", zip: "44787", street: "Beispielpfad" },
  { city: "Wuppertal", zip: "42103", street: "Testpfad" },
  { city: "Bielefeld", zip: "33602", street: "Demopfad" },
  { city: "Bonn", zip: "53111", street: "Musterallee" },
  { city: "Munster", zip: "48143", street: "Beispielallee" },

  { city: "Karlsruhe", zip: "76133", street: "Teststrasse" },
  { city: "Mannheim", zip: "68159", street: "Demostrasse" },
  { city: "Augsburg", zip: "86150", street: "Musterweg" },
  { city: "Wiesbaden", zip: "65183", street: "Beispielweg" },
  { city: "Gelsenkirchen", zip: "45879", street: "Testweg" },
  { city: "Monchengladbach", zip: "41061", street: "Demoweg" },
  { city: "Braunschweig", zip: "38100", street: "Musterplatz" },
  { city: "Chemnitz", zip: "09111", street: "Beispielplatz" },
  { city: "Kiel", zip: "24103", street: "Testplatz" },
  { city: "Aachen", zip: "52062", street: "Demoplatz" },

  { city: "Halle", zip: "06108", street: "Musterstrasse" },
  { city: "Magdeburg", zip: "39104", street: "Beispielstrasse" },
  { city: "Freiburg", zip: "79098", street: "Teststrasse" },
  { city: "Krefeld", zip: "47798", street: "Demostrasse" },
  { city: "Lubeck", zip: "23552", street: "Musterweg" },
  { city: "Oberhausen", zip: "46045", street: "Beispielweg" },
  { city: "Erfurt", zip: "99084", street: "Testweg" },
  { city: "Mainz", zip: "55116", street: "Demoweg" },
  { city: "Rostock", zip: "18055", street: "Musterallee" },
  { city: "Kassel", zip: "34117", street: "Beispielallee" },

  { city: "Hagen", zip: "58095", street: "Testallee" },
  { city: "Potsdam", zip: "14467", street: "Demoallee" },
  { city: "Saarbrucken", zip: "66111", street: "Musterstrasse" },
  { city: "Hamm", zip: "59065", street: "Beispielstrasse" },
  { city: "Ludwigshafen", zip: "67059", street: "Teststrasse" },
  { city: "Oldenburg", zip: "26122", street: "Demostrasse" },
  { city: "Osnabruck", zip: "49074", street: "Musterweg" },
  { city: "Leverkusen", zip: "51373", street: "Beispielweg" },
  { city: "Heidelberg", zip: "69117", street: "Testweg" },
  { city: "Darmstadt", zip: "64283", street: "Demoweg" }
];

// ==========================================
// RANDOM HELPERS
// ==========================================

function randomItem(array) {
  return array[crypto.randomInt(array.length)];
}

function randomNumber(min, max) {
  return crypto.randomInt(min, max + 1);
}

// ==========================================
// RANDOM BIRTHDAY
// Age between 18 and 60
// ==========================================

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

// ==========================================
// RANDOM STRONG PASSWORD
// ==========================================

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

// ==========================================
// RANDOM GENDER
// ==========================================

function generateGender() {
  return randomItem(["Male", "Female", "Diverse"]);
}

// ==========================================
// PURCHASE GERMAN NUMBER FROM HERO SMS
// ==========================================

async function getGermanNumber({ signal } = {}) {
  let paymentRejected = false;
  for (const operator of OPERATORS) {
    signal?.throwIfAborted();
    let result;
    try {
      result = await heroSMS('getNumberV2', { country: COUNTRY_ID, service: SERVICE_CODE, operator: operator.code }, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      // An explicit refusal has not allocated a number. A network failure or
      // lost purchase response is uncertain, so never try another purchase.
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

// ==========================================
// CHECK SMS STATUS
// ==========================================

async function getSMS(activationId, { signal } = {}) {
  if (!activationId) {
    throw new Error("Activation ID is required");
  }

  const result = await heroSMS("getStatus", {
    id: activationId
  }, { signal });

  // Standard HeroSMS responses are plain text.
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

// ==========================================
// WAIT FOR SMS
// ==========================================

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

// ==========================================
// GENERATE PROFILE WITH REAL HERO SMS NUMBER
// ==========================================

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

// ==========================================
// CLI
// ==========================================

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

// ==========================================
// EXPORT FOR OTHER FILES
// ==========================================

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

// Run only when executed directly
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
