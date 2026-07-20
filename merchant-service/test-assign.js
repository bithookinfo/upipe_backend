const axios = require('axios');
require('dotenv').config();

async function main() {
  try {
    const res = await axios.post(
      `http://127.0.0.1:4004/real-subscriptions/organizations/9501bcd1-0fb2-46ac-b589-f92dd4950daf/assign-slot`,
      { merchantId: 'temp-1781848249509' }
    );
    console.log('Success:', res.data);
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
  }
}

main();
