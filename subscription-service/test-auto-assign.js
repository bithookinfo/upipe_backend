const axios = require('axios');

async function test() {
  try {
    const response = await axios.get(`http://127.0.0.1:4002/merchant/list`, {
        headers: { 'x-organization-id': '9501bcd1-0fb2-46ac-b589-f92dd4950daf' }
    });
    console.log("Merchants:", response.data);
  } catch (err) {
    console.error("Error:", err.message);
  }
}
test();
