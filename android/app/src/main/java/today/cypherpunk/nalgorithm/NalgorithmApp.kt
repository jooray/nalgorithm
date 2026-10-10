package today.cypherpunk.nalgorithm

import android.app.Application
import android.content.Context

class NalgorithmApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
    }
}

val Context.graph: AppGraph get() = (applicationContext as NalgorithmApp).graph
