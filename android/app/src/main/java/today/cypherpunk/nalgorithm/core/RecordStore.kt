package today.cypherpunk.nalgorithm.core

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json

/**
 * The app's durable key/value records: the Android counterpart of the web app's
 * IndexedDB `records.ts`. Values are JSON text; keys are namespaced by prefix
 * (`score:`, `digest:`, `snapshot:`…), so one prefix can be listed or cleared.
 *
 * Blobs (audio) are not stored here; they live as files under [Context.getFilesDir].
 */
class RecordStore(context: Context, private val json: Json = AppJson) {
    private val helper = object : SQLiteOpenHelper(context.applicationContext, "records.db", null, 1) {
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE records (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated INTEGER NOT NULL)")
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    }

    suspend fun getRaw(key: String): String? = withContext(Dispatchers.IO) {
        helper.readableDatabase.rawQuery("SELECT value FROM records WHERE key = ?", arrayOf(key)).use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    }

    suspend fun putRaw(key: String, value: String) = withContext(Dispatchers.IO) {
        val values = ContentValues().apply {
            put("key", key)
            put("value", value)
            put("updated", System.currentTimeMillis())
        }
        helper.writableDatabase.insertWithOnConflict("records", null, values, SQLiteDatabase.CONFLICT_REPLACE)
        Unit
    }

    /** Many writes in one transaction (a scored batch, for example). */
    suspend fun putAllRaw(entries: Map<String, String>) = withContext(Dispatchers.IO) {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val now = System.currentTimeMillis()
            for ((k, v) in entries) {
                db.insertWithOnConflict("records", null, ContentValues().apply {
                    put("key", k); put("value", v); put("updated", now)
                }, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    suspend fun delete(key: String) = withContext(Dispatchers.IO) {
        helper.writableDatabase.delete("records", "key = ?", arrayOf(key))
        Unit
    }

    /** Every record whose key starts with [prefix], as (key, raw JSON). */
    suspend fun listRaw(prefix: String): List<Pair<String, String>> = withContext(Dispatchers.IO) {
        helper.readableDatabase.rawQuery(
            "SELECT key, value FROM records WHERE key >= ? AND key < ? ORDER BY key",
            arrayOf(prefix, prefix + "￿"),
        ).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0) to c.getString(1)) }
        }
    }

    suspend fun clear(prefix: String) = withContext(Dispatchers.IO) {
        helper.writableDatabase.delete("records", "key >= ? AND key < ?", arrayOf(prefix, prefix + "￿"))
        Unit
    }

    suspend fun <T> get(key: String, serializer: KSerializer<T>): T? =
        getRaw(key)?.let { runCatching { json.decodeFromString(serializer, it) }.getOrNull() }

    suspend fun <T> put(key: String, serializer: KSerializer<T>, value: T) = putRaw(key, json.encodeToString(serializer, value))

    suspend fun <T> list(prefix: String, serializer: KSerializer<T>): List<Pair<String, T>> =
        listRaw(prefix).mapNotNull { (k, v) -> runCatching { k to json.decodeFromString(serializer, v) }.getOrNull() }
}
