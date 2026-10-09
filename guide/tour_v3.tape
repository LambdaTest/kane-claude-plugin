Output tour-v3-raw.mp4
Set Shell zsh
Set FontSize 18
Set Width 1920
Set Height 1080
Set Padding 8
Set Framerate 24
Hide
Type "LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 tmux -u -L kqvid attach -t kq"
Enter
Sleep 1s
Show
# The driver detaches the session when the tour is over; the recording ends there.
Wait+Screen@1800s /detached/
Sleep 1s
