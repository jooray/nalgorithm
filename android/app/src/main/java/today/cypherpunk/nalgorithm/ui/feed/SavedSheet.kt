package today.cypherpunk.nalgorithm.ui.feed

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import today.cypherpunk.nalgorithm.AppGraph
import today.cypherpunk.nalgorithm.data.SavedNote
import today.cypherpunk.nalgorithm.model.PostType
import today.cypherpunk.nalgorithm.model.ProfileData
import today.cypherpunk.nalgorithm.model.ScoredPost
import today.cypherpunk.nalgorithm.ui.notes.DisplayPost
import today.cypherpunk.nalgorithm.ui.notes.NoteDetailSheet
import today.cypherpunk.nalgorithm.ui.notes.NoteTime
import today.cypherpunk.nalgorithm.ui.notes.shortName
import today.cypherpunk.nalgorithm.ui.theme.LinkButton
import today.cypherpunk.nalgorithm.ui.theme.Nal
import today.cypherpunk.nalgorithm.ui.theme.NalSheet

/** The notes saved for later on this device (feedback-ui.ts openSaved). A tap opens one in full. */
@Composable
fun SavedSheet(graph: AppGraph, profiles: Map<String, ProfileData>, onDismiss: () -> Unit) {
    val c = Nal.colors
    val feedback by graph.feedback.state.collectAsState()
    var opened by remember { mutableStateOf<SavedNote?>(null) }
    NalSheet(title = "Saved notes", onDismiss = onDismiss) {
        val notes = feedback.saved
        if (notes.isEmpty()) {
            Text("Nothing saved. Use Save for later in a note’s ••• menu.", color = c.text2, modifier = Modifier.padding(vertical = 12.dp))
            return@NalSheet
        }
        notes.forEachIndexed { i, n ->
            if (i > 0) HorizontalDivider(color = c.line)
            Column(
                Modifier
                    .fillMaxWidth()
                    .clickable(onClickLabel = "Open", role = Role.Button) { opened = n }
                    .padding(vertical = 12.dp),
            ) {
                Text("${shortName(n.author, profiles[n.author])} · ${NoteTime.relative(n.createdAt)}", color = c.text2, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Text(n.content, color = c.text, fontSize = 15.sp, lineHeight = 22.sp, maxLines = 8, modifier = Modifier.padding(top = 4.dp))
                LinkButton("Remove", { graph.feedback.unsaveNote(n.id) }, Modifier.padding(top = 2.dp))
            }
        }
    }
    opened?.let { n ->
        val post = ScoredPost(id = n.id, type = PostType.Original, author = n.author, content = n.content, createdAt = n.createdAt, score = Double.NaN)
        NoteDetailSheet(graph, DisplayPost(post), profiles, onDismiss = { opened = null })
    }
}
