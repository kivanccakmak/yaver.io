package main

import "testing"

func TestEnumerateLinuxMountsNeverProbesRemoteOrReadOnlyImageFilesystems(t *testing.T) {
	mounts := enumerateLinuxMounts(`/dev/sda1 / ext4 rw 0 0
//storage/backup /mnt/storagebox cifs rw 0 0
server:/exports /mnt/nfs nfs4 rw 0 0
rclone:bucket /mnt/archive fuse.rclone rw 0 0
/var/lib/snapd/snaps/core.snap /snap/core/1 squashfs ro 0 0
/dev/sdb1 /data xfs rw 0 0
`)
	if len(mounts) != 2 {
		t.Fatalf("mounts = %#v, want only the two local writable filesystems", mounts)
	}
	if mounts[0].Mount != "/" || mounts[1].Mount != "/data" {
		t.Fatalf("local mount order/content changed: %#v", mounts)
	}
}
