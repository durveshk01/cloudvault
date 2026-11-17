-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class com.cloudvault.app.UploadWorker { *; }
-keep class com.cloudvault.app.VaultPlugin { *; }
-keepclassmembers class * {
    @com.getcapacitor.PluginMethod <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
}
