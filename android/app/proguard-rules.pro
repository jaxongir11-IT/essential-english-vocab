# Essential English Vocab - ProGuard Rules
-keepattributes *Annotation*
-dontwarn okhttp3.**
-dontwarn okio.**
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
