// File: src/main.js (atau index.js)

import { Client, Databases, ID } from 'node-appwrite';

// Fungsi utama yang diekspor
export default async ({ req, res, log, error }) => {
  // --- 1. Inisialisasi & Validasi ---
  if (req.method !== 'POST') {
    return res.json({ ok: false, msg: 'Metode tidak diizinkan.' }, 405);
  }

  // Ambil data dari body permintaan
  const transactionData = JSON.parse(req.body);

  if (!transactionData || !transactionData.items || transactionData.items.length === 0) {
    return res.json({ ok: false, msg: 'Data transaksi tidak valid atau keranjang kosong.' }, 400);
  }
  if (!transactionData.shiftId) {
    return res.json({ ok: false, msg: "Shift tidak aktif." }, 400);
  }

  // Inisialisasi klien Appwrite dari variabel lingkungan
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const dbId = process.env.APPWRITE_DATABASE_ID;


const INVENTORY_ITEMS_COLLECTION_ID = process.env.INVENTORY_ITEMS_COLLECTION_ID;
const STOCK_MUTATIONS_COLLECTION_ID =  process.env.STOCK_MUTATIONS_COLLECTION_ID;
const CUSTOMERS_COLLECTION_ID =  process.env.CUSTOMERS_COLLECTION_ID;
const POS_SHIFTS_COLLECTION_ID =  process.env.POS_SHIFTS_COLLECTION_ID;
const POS_TRANSACTIONS_COLLECTION_ID =  process.env.POS_TRANSACTIONS_COLLECTION_ID;


  // // ID Koleksi (hardcode atau ambil dari env vars juga)
  // const INVENTORY_ITEMS_COLLECTION_ID = 'inventoryItems';
  // const STOCK_MUTATIONS_COLLECTION_ID = 'stockMutations';
  // const CUSTOMERS_COLLECTION_ID = 'customers';
  // const POS_SHIFTS_COLLECTION_ID = 'posShifts';
  // const POS_TRANSACTIONS_COLLECTION_ID = 'posTransactions';

  // --- 2. Proses Inti Transaksi (dibungkus try-catch) ---
  try {
    // A. Cek kecukupan stok untuk semua item SEBELUM melakukan operasi tulis apa pun
    for (const item of transactionData.items) {
      const inventoryDoc = await databases.getDocument(dbId, INVENTORY_ITEMS_COLLECTION_ID, item.itemId);
      if (inventoryDoc.quantity < item.quantity) {
        throw new Error(`Stok untuk ${item.name} tidak mencukupi (sisa ${inventoryDoc.quantity}).`);
      }
    }

    const transactionNumber = `TRX-${Date.now()}`;
    const change = transactionData.amountPaid - transactionData.total;

    // B. Buat dokumen transaksi utama
    const transactionDoc = await databases.createDocument(
      dbId,
      POS_TRANSACTIONS_COLLECTION_ID,
      ID.unique(),
      {
        ...transactionData,
        items: JSON.stringify(transactionData.items),
        transactionNumber,
        change,
      }
    );
    const transactionId = transactionDoc.$id;

    // C. Lakukan semua operasi tulis (Update stok & buat mutasi)
    for (const item of transactionData.items) {
      const inventoryDoc = await databases.getDocument(dbId, INVENTORY_ITEMS_COLLECTION_ID, item.itemId);
      const currentQuantity = inventoryDoc.quantity;
      const newQuantity = currentQuantity - item.quantity;
      
      // Update kuantitas
      await databases.updateDocument(dbId, INVENTORY_ITEMS_COLLECTION_ID, item.itemId, { quantity: newQuantity });

      // Buat catatan mutasi
      await databases.createDocument(dbId, STOCK_MUTATIONS_COLLECTION_ID, ID.unique(), {
        itemId: item.itemId,
        itemName: item.name,
        branchId: transactionData.branchId,
        change: -item.quantity,
        previousQuantity: currentQuantity,
        newQuantity,
        type: 'sale',
        description: `Penjualan via POS - Transaksi #${transactionNumber}`,
        relatedTransactionId: transactionId,
        userId: transactionData.userId,
        userName: transactionData.userName,
      });
    }

    // D. Update data pelanggan (jika ada)
    if (transactionData.customerId) {
      const customerDoc = await databases.getDocument(dbId, CUSTOMERS_COLLECTION_ID, transactionData.customerId);
      await databases.updateDocument(dbId, CUSTOMERS_COLLECTION_ID, transactionData.customerId, {
        totalTransactions: (customerDoc.totalTransactions || 0) + 1,
        totalSpent: (customerDoc.totalSpent || 0) + transactionData.total,
        lastTransactionDate: new Date().toISOString(),
      });
    }

    // E. Update total di dokumen shift
    const shiftDoc = await databases.getDocument(dbId, POS_SHIFTS_COLLECTION_ID, transactionData.shiftId);
    const shiftUpdate = {
        totalSales: (shiftDoc.totalSales || 0) + transactionData.total,
        totalCashPayments: shiftDoc.totalCashPayments || 0,
        totalOtherPayments: shiftDoc.totalOtherPayments || 0,
    };
    if (transactionData.paymentMethod === 'cash') {
      shiftUpdate.totalCashPayments += transactionData.total;
    } else {
      shiftUpdate.totalOtherPayments += transactionData.total;
    }
    await databases.updateDocument(dbId, POS_SHIFTS_COLLECTION_ID, transactionData.shiftId, shiftUpdate);

    // F. Jika semua berhasil, kirim respons sukses
    log(`Transaksi ${transactionNumber} berhasil diproses.`);
    return res.json({ ok: true, data: transactionDoc });

  } catch (e) {
    // --- 3. Penanganan Error ---
    error(`Transaksi gagal: ${e.message}`);
    // Jika terjadi error di mana pun, kirim respons error
    return res.json({ ok: false, msg: e.message || 'Terjadi kesalahan server.' }, 500);
  }
};