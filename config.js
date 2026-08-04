function required(name, fallback) {
  const val = process.env[name] ?? fallback;
  if (val === undefined) {
    console.warn(`⚠️  ENV ${name} belum diset — fitur yang butuh ini akan error.`);
  }
  return val;
}

module.exports = {
  //====== ( Owner ) ======//
  OWNER_ID: required("OWNER_ID"),

  //====== ( Tripay Getawey ) ======//
  TRIPAY_API_KEY: required("TRIPAY_API_KEY"),
  TRIPAY_PRIVATE_KEY: required("TRIPAY_PRIVATE_KEY"),
  TRIPAY_MERCHANT_CODE: required("TRIPAY_MERCHANT_CODE"),

  //======= ( Api Telegram ) ======//
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID || "",
  BROADCAST_CHANNEL_ID: process.env.BROADCAST_CHANNEL_ID || "",
  TELEGRAM_TOKEN: required("TELEGRAM_TOKEN"),
  API_BASE_URL: process.env.API_BASE_URL || "https://rumahapi.my.id/api",
  API_ADMIN_KEY: required("API_ADMIN_KEY"),

  //======= ( Reseller panel ) ======//
  RESELLER_PRICE: process.env.RESELLER_PRICE || "1000",
  RESELLER_GROUP_ID: process.env.RESELLER_GROUP_ID || "",
  RESELLER_GROUP_LINK: process.env.RESELLER_GROUP_LINK || "",

  //====== ( Order Kuota ) ======//
  QRIS_APIKEY: required("QRIS_APIKEY"),
  QRIS_CODEQR: required("QRIS_CODEQR"),
  QRIS_USERNAME: required("QRIS_USERNAME"),
  AUTH_TOKEN: required("AUTH_TOKEN"),
  MARCHATOK: required("MARCHATOK"),

  //====== ( Pakasir Payment Gateway ) ======//
  PAKASIR_API_KEY: required("PAKASIR_API_KEY"),
  PAKASIR_PROJECT: required("PAKASIR_PROJECT"),

  //====== ( GoPay Merchant / QRIS statis-dinamis — provider payment ke-2 ) ======//
  // Sama persis dengan yang dipakai fitur deposit di web (lib/qris.ts).
  // Cuma DIBUTUHIN kalau ada bot yang provider payment-nya di-set "gopay"
  // lewat dashboard — kalau semua bot masih pakai Pakasir, boleh dikosongin.
  QRIS_BASE_URL: process.env.QRIS_BASE_URL || "https://api-func-otp.vercel.app",
  QRIS_STATIC_CODE: process.env.QRIS_STATIC_CODE || "00020101021126610014COM.GO-JEK.WWW01189360091436347806500210G6347806500303UMI51440014ID.CO.QRIS.WWW0215ID10265198339370303UMI5204481453033605802ID5925FAHRI ALI, Pulsa & Intern6009TANGERANG61051573062070703A016304DB8C",
  QRIS_OTP_TOKEN: process.env.QRIS_OTP_TOKEN || "a6c4a73b-b460-462a-a27b-6d8cd3779b1a",
  QRIS_API_KEY: process.env.QRIS_API_KEY || "freeApikey",

  //====== ( Linode API ) ======//
  LINODE_API_TOKEN: required("LINODE_API_TOKEN"),

  //====== ( Digital Ocean ) ======//
  apidigital: process.env.DIGITAL_OCEAN_API || "_",

  //====== ( Settings Pterodactyl - PUBLIC ) ======//
  domain: required("PTERODACTYL_DOMAIN"),
  plta: required("PTERODACTYL_API_KEY"),
  egg: process.env.PTERODACTYL_EGG || "15",
  nestid: process.env.PTERODACTYL_NEST_ID || "5",
  loc: process.env.PTERODACTYL_LOCATION || "1",

  //====== ( Settings Pterodactyl - PRIVATE ) ======//
  domain_private: required("PTERODACTYL_DOMAIN_PRIVATE"),
  plta_private: required("PTERODACTYL_API_KEY_PRIVATE"),
  egg_private: process.env.PTERODACTYL_EGG_PRIVATE || "15",
  nestid_private: process.env.PTERODACTYL_NEST_ID_PRIVATE || "5",
  loc_private: process.env.PTERODACTYL_LOCATION_PRIVATE || "1"
};
