using UnityEngine;

public class AudioManager : MonoBehaviour
{
    public static AudioManager Instance;
    void Awake() { Instance = this; }

    public void PlaySound(string id) { /* AudioMixer routing */ }
}
