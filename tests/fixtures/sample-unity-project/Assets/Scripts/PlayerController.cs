using UnityEngine;

public class PlayerController : MonoBehaviour
{
    public float moveSpeed = 7.5f;
    public float dashForce = 18f;
    public Transform weaponController;

    void Update()
    {
        // sample
    }
}

public class GameManager : MonoBehaviour
{
    public static GameManager Instance;
    void Awake() { Instance = this; }
}
