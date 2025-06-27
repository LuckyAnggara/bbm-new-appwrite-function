// File: src/main.js (atau index.js)

import { Client, Databases, ID, Query } from 'node-appwrite';

// Fungsi utama yang diekspor
export default async ({ req, res, log, error }) => {
  log('[START] Fungsi transaksi POS dimulai...');

  // --- 1. Inisialisasi & Validasi ---
  if (req.method !== 'POST') {
    error('[ERROR] Metode tidak diizinkan. Hanya POST yang didukung.');
    return res.json({ ok: false, msg: 'Metode tidak diizinkan.' }, 405);
  }

  // Ambil data dari body permintaan dan log untuk debugging
  log('[INFO] Membaca body permintaan...');
  const transactionData = JSON.parse(req.body || '{}');
  log(`[DATA] Data transaksi yang diterima: ${JSON.stringify(transactionData, null, 2)}`);

  if (!transactionData || !transactionData.items || transactionData.items.length === 0) {
    error('[ERROR] Validasi gagal: Data transaksi tidak valid atau keranjang kosong.');
    return res.json({ ok: false, msg: 'Data transaksi tidak valid atau keranjang kosong.' }, 400);
  }
  if (!transactionData.shiftId) {
    error('[ERROR] Validasi gagal: Shift ID tidak ditemukan.');
    return res.json({ ok: false, msg: "Shift tidak aktif." }, 400);
  }
  log('[INFO] Validasi awal berhasil.');

  // Inisialisasi klien Appwrite
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);
  const dbId = process.env.APPWRITE_DATABASE_ID;

  // Variabel ID Koleksi
  const INVENTORY_ITEMS_COLLECTION_ID = process.env.INVENTORY_ITEMS_COLLECTION_ID;
  const STOCK_MUTATIONS_COLLECTION_ID = process.env.STOCK_MUTATIONS_COLLECTION_ID;
  const CUSTOMERS_COLLECTION_ID = process.env.CUSTOMERS_COLLECTION_ID;
  const POS_SHIFTS_COLLECTION_ID = process.env.POS_SHIFTS_COLLECTION_ID;
  const POS_TRANSACTIONS_COLLECTION_ID = process.env.POS_TRANSACTIONS_COLLECTION_ID;

  // --- 2. Proses Inti Transaksi (dibungkus try-catch) ---
  try {
    log('[STEP 1/5] Memeriksa ketersediaan stok...');
    for (const item of transactionData.items) {
      log(` -> Cek stok untuk item ID: ${item.itemId}, butuh: ${item.quantity}`);
      const inventoryDoc = await databases.getDocument(dbId, INVENTORY_ITEMS_COLLECTION_ID, item.itemId);
      if (inventoryDoc.quantity < item.quantity) {
        throw new Error(`Stok untuk ${item.name} tidak mencukupi (sisa ${inventoryDoc.quantity}).`);
      }
    }
    log('[SUCCESS] Stok tersedia untuk semua item.');

    const transactionNumber = `TRX-${Date.now()}`;

    log('[STEP 2/5] Membuat dokumen transaksi utama...');
    const transactionDoc = await databases.createDocument(
      dbId,
      POS_TRANSACTIONS_COLLECTION_ID,
      ID.unique(),
      {
        ...transactionData,
        items: JSON.stringify(transactionData.items),
        transactionNumber,
        change: transactionData.amountPaid - transactionData.totalAmount, // Pastikan menggunakan totalAmount yang benar
      }
    );
    const transactionId = transactionDoc.$id;
    log(`[SUCCESS] Dokumen transaksi berhasil dibuat dengan ID: ${transactionId}`);

    log('[STEP 3/5] Memperbarui stok dan membuat mutasi...');
    for (const item of transactionData.items) {
      log(` -> Proses item: ${item.name} (ID: ${item.itemId})`);
      const inventoryDoc = await databases.getDocument(dbId, INVENTORY_ITEMS_COLLECTION_ID, item.itemId);
      const currentQuantity = inventoryDoc.quantity;
      const newQuantity = currentQuantity - item.quantity;
      
      await databases.updateDocument(dbId, INVENTORY_ITEMS_COLLECTION_ID, item.itemId, { quantity: newQuantity });
      log(`   -> Stok item ${item.itemId} diupdate ke: ${newQuantity}`);

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
      log(`   -> Mutasi stok untuk item ${item.itemId} berhasil dibuat.`);
    }
    log('[SUCCESS] Semua stok dan mutasi berhasil diproses.');

    if (transactionData.customerId) {
      log('[STEP 4/5] Memperbarui data pelanggan...');
      const customerDoc = await databases.getDocument(dbId, CUSTOMERS_COLLECTION_ID, transactionData.customerId);
      await databases.updateDocument(dbId, CUSTOMERS_COLLECTION_ID, transactionData.customerId, {
        totalTransactions: (customerDoc.totalTransactions || 0) + 1,
        totalSpent: (customerDoc.totalSpent || 0) + transactionData.totalAmount,
        lastTransactionDate: new Date().toISOString(),
      });
      log(`[SUCCESS] Data pelanggan ID: ${transactionData.customerId} berhasil diupdate.`);
    }

    log('[STEP 5/5] Memperbarui data shift...');
    const shiftDoc = await databases.getDocument(dbId, POS_SHIFTS_COLLECTION_ID, transactionData.shiftId);
    const shiftUpdate = {
        totalSales: (shiftDoc.totalSales || 0) + transactionData.totalAmount,
        totalCashPayments: shiftDoc.totalCashPayments || 0,
        totalOtherPayments: shiftDoc.totalOtherPayments || 0,
        discountAmount: (shiftDoc.discountAmount || 0) + transactionData.totalDiscountAmount,
    };
    if (transactionData.paymentMethod === 'cash') {
      shiftUpdate.totalCashPayments += transactionData.totalAmount;
    } else {
      shiftUpdate.totalOtherPayments += transactionData.totalAmount;
    }
    await databases.updateDocument(dbId, POS_SHIFTS_COLLECTION_ID, transactionData.shiftId, shiftUpdate);
    log(`[SUCCESS] Data shift ID: ${transactionData.shiftId} berhasil diupdate.`);

    log(`[END] Transaksi ${transactionNumber} berhasil diproses sepenuhnya.`);
    return res.json({ ok: true, data: transactionDoc });

  } catch (e) {
    // --- 3. Penanganan Error ---
    error(`[FATAL] Transaksi gagal di tengah jalan. Error: ${e.message}`);
    // Log seluruh objek error untuk detail stack trace
    error(e); 
    return res.json({ ok: false, msg: e.message || 'Terjadi kesalahan server.' }, 500);
  }
};