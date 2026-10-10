# kotlinx.serialization: keep generated serializers for @Serializable classes.
-keepattributes *Annotation*, InnerClasses, Signature, Exceptions
-dontnote kotlinx.serialization.**
-keepclassmembers class today.cypherpunk.nalgorithm.** {
    *** Companion;
}
-keepclasseswithmembers class today.cypherpunk.nalgorithm.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class today.cypherpunk.nalgorithm.**$$serializer { *; }
-keepclassmembers @kotlinx.serialization.Serializable class today.cypherpunk.nalgorithm.** {
    <fields>;
}

-dontwarn okhttp3.internal.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
# secp256k1 JNI bindings are looked up by name from native code.
-keep class fr.acinq.secp256k1.** { *; }
