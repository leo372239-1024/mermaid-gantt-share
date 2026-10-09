' 读研甘特图（mermaid-gantt-share）本地服务 - 无窗口开机自启
'
' 作用：登录后静默执行 tools\local-up.cmd —— 先等 Docker 引擎就绪，再 docker compose up -d。
' 说明：容器本身已是 restart: unless-stopped，且 Docker Desktop 已设「登录时启动」；
'       本脚本是兜底，覆盖 Docker 启动较慢、或曾被 docker compose down 手动停过的情况。
'
' 安装：把本文件复制到启动文件夹
'       %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
'       （tools\install-autostart.cmd 可一键完成）
' 取消：从启动文件夹里删掉即可（服务不会停，只是不再自动拉起）。
Option Explicit

Dim shell, cmdPath, fso
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 项目根目录（本脚本从启动文件夹运行，无法用相对路径定位，只能写绝对路径）
cmdPath = "G:\IT_develop\github_projects\mermaid-gantt-share\tools\local-up.cmd"

If Not fso.FileExists(cmdPath) Then
    WScript.Quit 1
End If

' 第二个参数 0 = 完全隐藏窗口（不闪黑框），第三个 False = 不等待返回
shell.Run "cmd.exe /c """ & cmdPath & """", 0, False

WScript.Quit 0
