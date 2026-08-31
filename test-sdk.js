require('dotenv').config();
const Intasend = require('intasend-node');

const intasend = new Intasend(
  process.env.INTASEND_API_KEY,
  process.env.INTASEND_PUBLIC_KEY,
  'production'
);

(async () => {
  try {
    const response = await intasend.collections.mpesaStkPush({
      phone_number: '254712345678',
      amount: 10,
      reference: 'test_123',
      purpose: 'Test'
    });
    console.log('Success:', response);
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
  }
})();