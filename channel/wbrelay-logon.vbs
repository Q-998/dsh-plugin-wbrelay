' wbrelay channel one-shot starter (hidden window, runs ONCE at logon)
' 非循环：登录时把服务拉起一次即退出，服务独立于 dsh 存活
' 自定位：按本文件所在目录查找 orchestrator.cjs，复制到任何路径都可用
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("Wscript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(node) Then node = sh.ExpandEnvironmentStrings("%APPDATA%") & "\npm\node.exe"
sh.Run """" & node & """ """ & dir & "\orchestrator.cjs""", 0, False
